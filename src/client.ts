import type { ConnectionOptions, Job, KeepJobs } from 'bullmq';
import { Queue, QueueEvents } from 'bullmq';

import {
  buildConversationHistory,
  expandAggregatorResult,
  fetchAggregatorResultsWithChildren,
  fetchSessionResults,
} from './history.js';
import type {
  AgentClientOptions,
  JobProgress,
  JobRetention,
  JobType,
  OrchestratorJobData,
  ResumeCommand,
  SerializedMessage,
  StepResult,
} from './types.js';
import {
  AGENT_QUEUE,
  AGGREGATOR_QUEUE,
  DEFAULT_JOB_RETENTION,
  getQueueName,
  ORCHESTRATOR_QUEUE,
} from './types.js';
import { waitForJobWithProgress } from './waitWithProgress.js';

export class AgentClient {
  private readonly connection: ConnectionOptions;
  private readonly orchestratorQueue: Queue;
  private readonly aggregatorQueue: Queue;
  private readonly orchestratorEvents: QueueEvents;
  private readonly aggregatorEvents: QueueEvents;
  private readonly agentEvents: QueueEvents;
  private readonly retention: Required<JobRetention>;
  private readonly keepResult: KeepJobs;

  constructor(options: AgentClientOptions) {
    this.connection = options.connection;
    this.retention = { ...DEFAULT_JOB_RETENTION, ...options.jobRetention };
    this.keepResult = { age: this.retention.age, count: this.retention.count };
    const prefix = options.queuePrefix;
    const orchQueue = getQueueName(prefix, ORCHESTRATOR_QUEUE);
    const aggQueue = getQueueName(prefix, AGGREGATOR_QUEUE);
    const agentQueue = getQueueName(prefix, AGENT_QUEUE);
    this.orchestratorQueue = new Queue(orchQueue, {
      connection: this.connection,
    });
    this.aggregatorQueue = new Queue(aggQueue, {
      connection: this.connection,
    });
    this.orchestratorEvents = new QueueEvents(orchQueue, {
      connection: this.connection,
    });
    this.aggregatorEvents = new QueueEvents(aggQueue, {
      connection: this.connection,
    });
    this.agentEvents = new QueueEvents(agentQueue, {
      connection: this.connection,
    });
  }

  /**
   * Send a new user message. For human-in-the-loop (approve/reject tools or reply to
   * human_in_the_loop), use sendCommand() instead.
   */
  async sendPrompt(
    sessionId: string,
    prompt: string,
    options?: {
      context?: Record<string, unknown>;
      /** When set, use this goal only (no LLM routing). */
      goalId?: string;
      /** Optional prefix messages for the conversation. */
      initialMessages?: SerializedMessage[];
      /** Job priority (BullMQ: lower number = higher priority). */
      priority?: number;
      /** Enforce a tool choice for this step (e.g. tool name, "auto", "any", "none"). */
      toolChoice?: string | Record<string, unknown> | 'auto' | 'any' | 'none';
      /** When true, tools run automatically without confirmation. When omitted or false, user confirmation is required. */
      autoExecuteTools?: boolean;
      /** Called when the job reports progress (e.g. prompt-read, thinking, typing). Uses BullMQ job progress. */
      onProgress?: (progress: JobProgress) => void;
    },
  ): Promise<StepResult> {
    const job = await this.addOrchestratorJob(sessionId, {
      type: 'prompt',
      prompt,
      ...options,
    });
    return this.resolveResult(job, options?.onProgress);
  }

  /**
   * Resume after the agent returned status 'interrupted'.
   *
   * @example
   * // Approve tools:
   * sendCommand(sessionId, { type: 'tool_approval', approved: { SearchFlights: true } })
   *
   * // Tip the agent (agent formulates reply):
   * sendCommand(sessionId, { type: 'hitl_response', response: 'The answer is 42' })
   *
   * // Reply as the agent directly (no model call):
   * sendCommand(sessionId, { type: 'hitl_direct_reply', message: 'Here is the answer.' })
   */
  async sendCommand(
    sessionId: string,
    command: ResumeCommand,
    options?: {
      context?: Record<string, unknown>;
      /** Called when the job reports progress. */
      onProgress?: (progress: JobProgress) => void;
    },
  ): Promise<StepResult> {
    const job = await this.addOrchestratorJob(sessionId, {
      type: 'command',
      command,
      ...(options?.context !== undefined && { context: options.context }),
    });
    return this.resolveResult(job, options?.onProgress);
  }

  async endChat(
    sessionId: string,
    context?: Record<string, unknown>,
  ): Promise<StepResult> {
    const job = await this.addOrchestratorJob(sessionId, {
      type: 'end-chat',
      context,
    });
    return this.resolveResult(job);
  }

  // -----------------------------------------------------------------------
  // State queries
  // -----------------------------------------------------------------------

  /**
   * Reconstruct the full conversation by fetching all step deltas
   * from both orchestrator and aggregator queues via ZSCAN + pipelined HGET.
   */
  async getConversationHistory(
    sessionId: string,
  ): Promise<SerializedMessage[]> {
    const [orchResults, aggPairs] = await Promise.all([
      fetchSessionResults(this.orchestratorQueue, sessionId),
      fetchAggregatorResultsWithChildren(this.aggregatorQueue, sessionId),
    ]);
    const aggResults = aggPairs.map(([, r]) => r);
    return buildConversationHistory(orchResults, aggResults);
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  async close(): Promise<void> {
    await this.orchestratorEvents.close();
    await this.aggregatorEvents.close();
    await this.agentEvents.close();
    await this.orchestratorQueue.close();
    await this.aggregatorQueue.close();
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async addOrchestratorJob(
    sessionId: string,
    extra: {
      type: JobType;
      prompt?: string;
      command?: ResumeCommand;
      context?: Record<string, unknown>;
      goalId?: string;
      initialMessages?: SerializedMessage[];
      priority?: number;
      toolChoice?: string | Record<string, unknown> | 'auto' | 'any' | 'none';
    },
  ): Promise<Job<OrchestratorJobData>> {
    const { priority, ...jobData } = extra;
    const opts: { jobId: string; removeOnComplete: KeepJobs; removeOnFail: KeepJobs; priority?: number } = {
      jobId: `${sessionId}/${Date.now()}`,
      removeOnComplete: this.keepResult,
      removeOnFail: this.keepResult,
    };
    if (priority !== undefined) opts.priority = priority;
    return this.orchestratorQueue.add(
      'orchestrator-step',
      { sessionId, ...jobData } satisfies OrchestratorJobData,
      opts,
    );
  }

  private async resolveResult(
    job: Job<OrchestratorJobData>,
    onProgress?: (progress: JobProgress) => void,
  ): Promise<StepResult> {
    const sessionId = job.data.sessionId;
    const rawResult = await waitForJobWithProgress<StepResult | string>(
      job,
      this.orchestratorEvents,
      onProgress,
    );
    const result: StepResult =
      typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult;

    if (result.status === 'routing' && result.routingJobId) {
      return this.waitForAggregator(
        result.routingJobId,
        sessionId,
        onProgress,
      );
    }

    return result;
  }

  private async waitForAggregator(
    aggregatorJobId: string,
    sessionId: string,
    onProgress?: (progress: JobProgress) => void,
  ): Promise<StepResult> {
    const aggJob = await this.aggregatorQueue.getJob(aggregatorJobId);
    if (!aggJob) {
      throw new Error(`Aggregator job ${aggregatorJobId} not found`);
    }

    const effectiveSessionId =
      sessionId ?? (aggJob.data as { sessionId?: string }).sessionId;

    const rawResult = await waitForJobWithProgress<StepResult | string>(
      aggJob,
      this.aggregatorEvents,
      onProgress,
      [
        ...(effectiveSessionId ? [{
          events: this.agentEvents,
          isRelevant: (_jobId: string, data: unknown) =>
            data != null &&
            typeof data === 'object' &&
            'sessionId' in data &&
            data.sessionId === effectiveSessionId,
        }] : []),
      ],
    );
    const result: StepResult =
      typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult;
    // Aggregator return value is stored without childrenValues; expand from flow.
    const children = await aggJob.getChildrenValues<StepResult>();
    return expandAggregatorResult(result, children ?? {});
  }
}
