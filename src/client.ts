import type { ConnectionOptions, Job, KeepJobs } from 'bullmq';
import { Queue, QueueEvents } from 'bullmq';

import {
  buildConversationHistory,
  fetchSessionResults
} from './history.js';
import type {
  AgentClientOptions,
  JobRetention,
  OrchestratorJobData,
  SerializedMessage,
  StepResult
} from './types.js';
import {
  AGGREGATOR_QUEUE,
  DEFAULT_JOB_RETENTION,
  ORCHESTRATOR_QUEUE,
} from './types.js';

export class AgentClient {
  private readonly connection: ConnectionOptions;
  private readonly orchestratorQueue: Queue;
  private readonly aggregatorQueue: Queue;
  private readonly orchestratorEvents: QueueEvents;
  private readonly aggregatorEvents: QueueEvents;
  private readonly retention: Required<JobRetention>;
  private readonly keepResult: KeepJobs;

  constructor(options: AgentClientOptions) {
    this.connection = options.connection;
    this.retention = { ...DEFAULT_JOB_RETENTION, ...options.jobRetention };
    this.keepResult = { age: this.retention.age, count: this.retention.count };
    this.orchestratorQueue = new Queue(ORCHESTRATOR_QUEUE, {
      connection: this.connection,
    });
    this.aggregatorQueue = new Queue(AGGREGATOR_QUEUE, {
      connection: this.connection,
    });
    this.orchestratorEvents = new QueueEvents(ORCHESTRATOR_QUEUE, {
      connection: this.connection,
    });
    this.aggregatorEvents = new QueueEvents(AGGREGATOR_QUEUE, {
      connection: this.connection,
    });
  }

  async sendPrompt(sessionId: string, prompt: string): Promise<StepResult> {
    const job = await this.addOrchestratorJob(sessionId, {
      type: 'prompt',
      prompt,
    });
    return this.resolveResult(job);
  }

  async confirm(sessionId: string): Promise<StepResult> {
    const job = await this.addOrchestratorJob(sessionId, { type: 'confirm' });
    return this.resolveResult(job);
  }

  async endChat(sessionId: string): Promise<StepResult> {
    const job = await this.addOrchestratorJob(sessionId, { type: 'end-chat' });
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
    const [orchResults, aggResults] = await Promise.all([
      fetchSessionResults(this.orchestratorQueue, sessionId),
      fetchSessionResults(this.aggregatorQueue, sessionId),
    ]);

    return buildConversationHistory(orchResults, aggResults);
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  async close(): Promise<void> {
    await this.orchestratorEvents.close();
    await this.aggregatorEvents.close();
    await this.orchestratorQueue.close();
    await this.aggregatorQueue.close();
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async addOrchestratorJob(
    sessionId: string,
    extra: { type: OrchestratorJobData['type']; prompt?: string },
  ): Promise<Job> {
    return this.orchestratorQueue.add(
      'orchestrator-step',
      { sessionId, ...extra } satisfies OrchestratorJobData,
      {
        jobId: `${sessionId}/${Date.now()}`,
        removeOnComplete: this.keepResult,
        removeOnFail: this.keepResult,
      },
    );
  }

  private async resolveResult(job: Job): Promise<StepResult> {
    const rawResult = await job.waitUntilFinished(this.orchestratorEvents);
    const result: StepResult =
      typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult;

    if (result.status === 'routing' && result.routingJobId) {
      return this.waitForAggregator(result.routingJobId);
    }

    return result;
  }

  private async waitForAggregator(
    aggregatorJobId: string,
  ): Promise<StepResult> {
    const aggJob = await this.aggregatorQueue.getJob(aggregatorJobId);
    if (!aggJob) {
      throw new Error(`Aggregator job ${aggregatorJobId} not found`);
    }

    const rawResult = await aggJob.waitUntilFinished(this.aggregatorEvents);
    return typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult;
  }
}
