import type { StoredMessage } from "@langchain/core/messages";
import type { AgentWorkerLogger, ModelOptions } from "../options.js";
import { Worker, WorkerOptions } from "bullmq";
import type { Job } from "bullmq";
import { QUEUE_NAMES, RunContext } from "../options.js";
import type { AgentJobResult, AggregatorJobData } from "../queues/types.js";
import type { ResumeWorker } from "./resumeWorker.js";

export interface AggregatorWorkerParams {
  resumeWorker: ResumeWorker;
  embeddingModelOptions: ModelOptions;
  logger: AgentWorkerLogger;
}

/**
 * Aggregator worker: runs as the parent of a flow after all tool/subagent children complete.
 * Builds tool messages from children results and resumes the graph via the shared ResumeWorker.
 * Returns AgentJobResult so the client can use this job's result without waiting for an agent job.
 */
export class AggregatorWorker {
  private readonly resumeWorker: ResumeWorker;
  private readonly embeddingModelOptions: ModelOptions;
  private readonly logger: AgentWorkerLogger;
  private readonly options: WorkerOptions;
  private _started = false;
  private worker: Worker<AggregatorJobData> | null = null;

  constructor(params: AggregatorWorkerParams, options: WorkerOptions) {
    this.resumeWorker = params.resumeWorker;
    this.embeddingModelOptions = params.embeddingModelOptions;
    this.logger = params.logger;
    this.options = options;
  }

  /** Process a single aggregator job (used by the worker and by tests). */
  async processJob(job: Job<AggregatorJobData>): Promise<AgentJobResult> {
    const childrenValues = await job.getChildrenValues();
    const { agentId, threadId, chatModelOptions, goalId } = job.data;

    // Job IDs are snowflake IDs; sort by key to preserve tool-call order.
    const sortedKeys = Object.keys(childrenValues).sort();
    const messages: StoredMessage[] = sortedKeys.map((key) => childrenValues[key] as StoredMessage);

    const configurable: RunContext = {
      thread_id: threadId,
      agentId,
      job,
      goalId,
      chatModelOptions,
      embeddingModelOptions: this.embeddingModelOptions,
    };
    return this.resumeWorker.runResume(configurable, { messages });
  }

  start() {
    if (this._started) return;
    this.worker = new Worker<AggregatorJobData>(
      QUEUE_NAMES.AGGREGATOR,
      (job: Job<AggregatorJobData>) => this.processJob(job),
      { ...this.options }
    );

    this.worker.on("completed", (job) => {
      this.logger.debug(`[aggregator] Job ${job.id} completed`);
    });
    this.worker.on("failed", (job, err) => {
      this.logger.error(`[aggregator] Job ${job?.id} failed`, err);
    });
    this._started = true;
  }

  async close(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
  }
}
