import type { ConnectionOptions, Job, KeepJobs } from 'bullmq';
import { Queue, QueueEvents } from 'bullmq';

import {
  buildConversationHistory,
  expandAggregatorResult,
  fetchAggregatorResultsWithChildren,
  fetchSessionResults,
} from './history.js';
import {
  getSessionConfig as getSessionConfigStore,
  setSessionConfig as setSessionConfigStore,
  type SessionConfig,
  type RedisLike,
} from './sessionConfig.js';
import type {
  AgentClientOptions,
  DocumentJobData,
  DocumentSource,
  JobProgress,
  JobRetention,
  JobType,
  ModelClientOptions,
  OrchestratorJobData,
  PromptAttachment,
  ResumeCommand,
  SerializedMessage,
  StepResult,
} from './types.js';
import {
  AGENT_QUEUE,
  AGGREGATOR_QUEUE,
  DEFAULT_JOB_RETENTION,
  DOCUMENT_QUEUE,
  getQueueName,
  ORCHESTRATOR_QUEUE,
} from './types.js';
import { waitForJobWithProgress } from './waitWithProgress.js';

// ---------------------------------------------------------------------------
// ModelClient — session + prompt only (no agent)
// ---------------------------------------------------------------------------

/**
 * Client for sending prompts and managing sessions without the agent concept.
 * Use this when you only need goals/tools and don't need per-agent RAG or agentId.
 * For agent-aware flows (agentId, addDocument), use AgentClient.
 */
export class ModelClient {
  protected readonly connection: ConnectionOptions;
  protected readonly queuePrefix: string;
  protected readonly orchestratorQueue: Queue;
  protected readonly aggregatorQueue: Queue;
  protected readonly orchestratorEvents: QueueEvents;
  protected readonly aggregatorEvents: QueueEvents;
  protected readonly agentEvents: QueueEvents;
  protected readonly retention: Required<JobRetention>;
  protected readonly keepResult: KeepJobs;

  constructor(options: ModelClientOptions) {
    this.connection = options.connection;
    this.queuePrefix = options.queuePrefix ?? '';
    this.retention = { ...DEFAULT_JOB_RETENTION, ...options.jobRetention };
    this.keepResult = { age: this.retention.age, count: this.retention.count };
    const prefix = this.queuePrefix;
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
   * Send a new user message (no agent). For human-in-the-loop, use sendCommand() instead.
   */
  async sendPrompt(
    sessionId: string,
    prompt: string,
    options?: {
      attachments?: PromptAttachment[];
      context?: Record<string, unknown>;
      goalId?: string;
      initialMessages?: SerializedMessage[];
      priority?: number;
      toolChoice?: string | Record<string, unknown> | 'auto' | 'any' | 'none';
      sessionConfig?: SessionConfig;
      onProgress?: (progress: JobProgress) => void;
    },
  ): Promise<StepResult> {
    const job = await this.addOrchestratorJob(sessionId, undefined, {
      type: 'prompt',
      prompt,
      ...options,
    });
    return this.resolveResult(job, options?.onProgress);
  }

  /**
   * Resume after status 'interrupted' (tool approval or human_in_the_loop).
   */
  async sendCommand(
    sessionId: string,
    command: ResumeCommand,
    options?: {
      context?: Record<string, unknown>;
      onProgress?: (progress: JobProgress) => void;
    },
  ): Promise<StepResult> {
    const job = await this.addOrchestratorJob(sessionId, undefined, {
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
    const job = await this.addOrchestratorJob(sessionId, undefined, {
      type: 'end-chat',
      context,
    });
    return this.resolveResult(job);
  }

  async setSessionConfig(
    sessionId: string,
    config: SessionConfig,
  ): Promise<void> {
    const redis = (await this.orchestratorQueue.client) as RedisLike;
    await setSessionConfigStore(redis, this.queuePrefix, sessionId, config);
  }

  async getSessionConfig(sessionId: string): Promise<Required<SessionConfig>> {
    const redis = (await this.orchestratorQueue.client) as RedisLike;
    return getSessionConfigStore(redis, this.queuePrefix, sessionId);
  }

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

  async close(): Promise<void> {
    await this.orchestratorEvents.close();
    await this.aggregatorEvents.close();
    await this.agentEvents.close();
    await this.orchestratorQueue.close();
    await this.aggregatorQueue.close();
  }

  /** Submit a job (used by AgentClient when wrapping with agentId). */
  async addOrchestratorJob(
    sessionId: string,
    agentId: string | undefined,
    extra: {
      type: JobType;
      prompt?: string;
      attachments?: PromptAttachment[];
      command?: ResumeCommand;
      context?: Record<string, unknown>;
      goalId?: string;
      initialMessages?: SerializedMessage[];
      priority?: number;
      toolChoice?: string | Record<string, unknown> | 'auto' | 'any' | 'none';
      sessionConfig?: SessionConfig;
      onProgress?: (progress: JobProgress) => void;
    },
  ): Promise<Job<OrchestratorJobData>> {
    const { priority, onProgress: _onProgress, ...jobData } = extra;
    const opts: { jobId: string; removeOnComplete: KeepJobs; removeOnFail: KeepJobs; priority?: number } = {
      jobId: `${sessionId}/${Date.now()}`,
      removeOnComplete: this.keepResult,
      removeOnFail: this.keepResult,
    };
    if (priority !== undefined) opts.priority = priority;
    const data: OrchestratorJobData = {
      sessionId,
      ...(agentId !== undefined && { agentId }),
      ...jobData,
    };
    return this.orchestratorQueue.add('orchestrator-step', data, opts);
  }

  /** Wait for job result (used by AgentClient when wrapping). */
  async resolveResult(
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

  protected async waitForAggregator(
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
    const children = await aggJob.getChildrenValues<StepResult>();
    return expandAggregatorResult(result, children ?? {});
  }
}

// ---------------------------------------------------------------------------
// AgentClient — wraps ModelClient with agentId and addDocument
// ---------------------------------------------------------------------------

/**
 * Agent-aware client. Wraps ModelClient with agentId on send methods and addDocument that sends the document to the worker (worker uses its getAgent and rag config to ingest).
 */
export class AgentClient {
  private readonly modelClient: ModelClient;
  private readonly documentQueue: Queue<DocumentJobData>;
  private readonly documentEvents: QueueEvents;

  constructor(options: AgentClientOptions) {
    this.modelClient = new ModelClient(options);
    const prefix = options.queuePrefix ?? '';
    const docQueueName = getQueueName(prefix, DOCUMENT_QUEUE);
    this.documentQueue = new Queue<DocumentJobData>(docQueueName, {
      connection: options.connection,
    });
    this.documentEvents = new QueueEvents(docQueueName, {
      connection: options.connection,
    });
  }

  /** Send a new user message for the given agent. */
  async sendPrompt(
    agentId: string,
    sessionId: string,
    prompt: string,
    options?: {
      attachments?: PromptAttachment[];
      context?: Record<string, unknown>;
      goalId?: string;
      initialMessages?: SerializedMessage[];
      priority?: number;
      toolChoice?: string | Record<string, unknown> | 'auto' | 'any' | 'none';
      sessionConfig?: SessionConfig;
      onProgress?: (progress: JobProgress) => void;
    },
  ): Promise<StepResult> {
    const job = await this.modelClient.addOrchestratorJob(sessionId, agentId, {
      type: 'prompt',
      prompt,
      ...options,
    });
    return this.modelClient.resolveResult(job, options?.onProgress);
  }

  /** Resume after status 'interrupted' for the given agent. */
  async sendCommand(
    agentId: string,
    sessionId: string,
    command: ResumeCommand,
    options?: {
      context?: Record<string, unknown>;
      onProgress?: (progress: JobProgress) => void;
    },
  ): Promise<StepResult> {
    const job = await this.modelClient.addOrchestratorJob(sessionId, agentId, {
      type: 'command',
      command,
      ...(options?.context !== undefined && { context: options.context }),
    });
    return this.modelClient.resolveResult(job, options?.onProgress);
  }

  async endChat(
    sessionId: string,
    agentId: string,
    context?: Record<string, unknown>,
  ): Promise<StepResult> {
    const job = await this.modelClient.addOrchestratorJob(sessionId, agentId, {
      type: 'end-chat',
      context,
    });
    return this.modelClient.resolveResult(job);
  }

  /** Send a document to the worker for ingestion into the agent's RAG index. The worker uses getAgent and rag config from its constructor. */
  async addDocument(agentId: string, source: DocumentSource): Promise<void> {
    const job = await this.documentQueue.add(
      'add-document',
      { agentId, source } satisfies DocumentJobData,
      { jobId: `doc/${agentId}/${Date.now()}` },
    );
    await job.waitUntilFinished(this.documentEvents);
  }

  async setSessionConfig(
    sessionId: string,
    config: SessionConfig,
  ): Promise<void> {
    return this.modelClient.setSessionConfig(sessionId, config);
  }

  async getSessionConfig(sessionId: string): Promise<Required<SessionConfig>> {
    return this.modelClient.getSessionConfig(sessionId);
  }

  async getConversationHistory(
    sessionId: string,
  ): Promise<SerializedMessage[]> {
    return this.modelClient.getConversationHistory(sessionId);
  }

  async close(): Promise<void> {
    await this.documentEvents.close();
    await this.documentQueue.close();
    return this.modelClient.close();
  }
}
