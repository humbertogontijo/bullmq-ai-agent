import type { StoredMessage } from "@langchain/core/messages";
import type { Queue, QueueBaseOptions } from "bullmq";
import { QueueEvents } from "bullmq";
import type { ModelOptions } from "./options.js";
import { QUEUE_NAMES } from "./options.js";
import { createAgentQueue } from "./queues/agentQueue.js";
import { createAggregatorQueue } from "./queues/aggregatorQueue.js";
import { createIngestQueue } from "./queues/ingestQueue.js";
import type { AgentJobData, AgentJobResult, AggregatorJobData, IngestJobData } from "./queues/types.js";

export type MessageRole = "user" | "assistant" | "system";

/** Progress payload from BullMQ job (worker calls job.updateProgress). */
export interface JobProgress {
  stage: string;
  [key: string]: unknown;
}

export interface RunOptions {
  /** Chat model (provider, model, apiKey). Pass apiKey from the caller (e.g. CLI); library does not read process.env. */
  chatModelOptions: ModelOptions;
  /** Goal id; when set, the goal's system prompt is used for the model (must match a goal id from BullMQAgentWorker options). */
  goalId?: string;
  /** Initial messages (e.g. [{ role: "user", content: "Hello" }]). */
  messages: StoredMessage[];
  /** Called when the worker reports progress (e.g. graph node stage). Uses BullMQ job progress. */
  onProgress?: (progress: JobProgress) => void;
}

export interface ResumeOptions {
  /** Called when the worker reports progress (e.g. graph node stage). Uses BullMQ job progress. */
  onProgress?: (progress: JobProgress) => void;
}

export interface IngestDocument {
  type: 'url' | 'file' | 'text';
  content: string;
  metadata?: Record<string, unknown>;
}

export interface IngestOptions {
  /** Agent id for which to ingest the document. */
  agentId: string;
  source: IngestDocument;
}

export interface RunResult {
  agentId: string;
  threadId: string;
  jobId: string | undefined;
}

const defaultWaitTtl = 120_000; // 2 minutes

/**
 * Client for invoking the BullMQ agent: start runs, resume after human-in-the-loop, and ingest documents for RAG.
 * Call start() to open queue connections; call close() when done so connections are not opened/closed per call.
 */
export class BullMQAgentClient {
  private readonly options: QueueBaseOptions;
  private readonly agentQueue: Queue<AgentJobData>;
  private readonly aggregatorQueue: Queue<AggregatorJobData>;
  private readonly ingestQueue: Queue<IngestJobData>;
  private readonly agentQueueEvents: QueueEvents;
  private readonly aggregatorQueueEvents: QueueEvents;

  constructor(options: QueueBaseOptions) {
    this.options = options;
    this.agentQueue = createAgentQueue({ ...this.options });
    this.aggregatorQueue = createAggregatorQueue({ ...this.options });
    this.ingestQueue = createIngestQueue({ ...this.options });
    this.agentQueueEvents = new QueueEvents(QUEUE_NAMES.AGENT, { ...this.options });
    this.aggregatorQueueEvents = new QueueEvents(QUEUE_NAMES.AGGREGATOR, { ...this.options });
  }

  /**
   * Close all queue connections.
   */
  async close(): Promise<void> {
    await Promise.all([
      this.agentQueueEvents.close(),
      this.aggregatorQueueEvents.close(),
      this.agentQueue.close(),
      this.aggregatorQueue.close(),
      this.ingestQueue.close(),
    ]);
  }

  /**
   * Start a new agent run (fire-and-forget). Returns agentId, threadId and jobId.
   */
  async run(
    agentId: string,
    threadId: string,
    options: RunOptions
  ): Promise<RunResult> {
    const agentQueue = this.agentQueue;
    const messages = options.messages;
    const job = await agentQueue.add("run", {
      agentId: agentId,
      threadId: threadId,
      chatModelOptions: options.chatModelOptions,
      goalId: options.goalId,
      input: { messages },
    });
    if (options.onProgress && job.id) {
      this.subscribeToJobProgress(job.id, options.onProgress);
    }
    return { agentId, threadId, jobId: job.id };
  }

  /**
   * Run and wait for the job to complete (or interrupt). Use for sync-style chat.
   * When the agent interrupts for a tool or subagent, waits for the worker-enqueued resume job(s) automatically;
   * returns only when the run completes with a final message or a human-in-the-loop interrupt.
   */
  async runAndWait(
    agentId: string,
    threadId: string,
    options: RunOptions,
    ttl: number = defaultWaitTtl
  ): Promise<AgentJobResult> {
    const { jobId } = await this.run(agentId, threadId, options);
    if (!jobId) return { status: "completed" };
    const job = await this.agentQueue.getJob(jobId);
    if (!job) return { status: "completed" };
    let result: AgentJobResult = await job.waitUntilFinished(this.agentQueueEvents, ttl);
    while (result.status === "interrupted") {
      const payload = result.interruptPayload;
      if (payload?.type === "aggregator") {
        result = await this.waitForAggregatorJobResult(payload.aggregatorJobId, ttl);
        continue;
      }
      break;
    }
    return result;
  }

  /**
 * Resume a run after a human-in-the-loop interrupt (fire-and-forget).
 */
  async resume(
    agentId: string,
    threadId: string,
    result: unknown,
    options: ResumeOptions = {}
  ): Promise<{ jobId: string | undefined }> {
    const job = await this.agentQueue.add("resume", {
      agentId: agentId,
      threadId: threadId,
      result: result,
      interruptPayload: { type: "human" },
    });
    if (options.onProgress && job.id) {
      this.subscribeToJobProgress(job.id, options.onProgress);
    }
    return { jobId: job.id };
  }

  /**
   * Resume and wait for the job to complete (or next interrupt). When the agent interrupts for a tool or subagent,
   * waits for the worker-enqueued resume job(s) automatically; returns only on completion or human interrupt.
   */
  async resumeAndWait(
    agentId: string,
    threadId: string,
    result: unknown,
    options: ResumeOptions = {},
    ttl: number = defaultWaitTtl
  ): Promise<AgentJobResult> {
    const job = await this.agentQueue.add("resume", {
      agentId,
      threadId: threadId,
      result,
      interruptPayload: { type: "human" }
    });
    if (options.onProgress && job.id) {
      this.subscribeToJobProgress(job.id, options.onProgress);
    }
    if (!job.id) return { status: "completed" };
    const fullJob = await this.agentQueue.getJob(job.id);
    if (!fullJob) return { status: "completed" };
    let out: AgentJobResult = await fullJob.waitUntilFinished(this.agentQueueEvents, ttl);
    while (out.status === "interrupted") {
      const payload = out.interruptPayload;
      if (payload?.type === "aggregator") {
        out = await this.waitForAggregatorJobResult(payload.aggregatorJobId, ttl);
        continue;
      }
      break;
    }
    return out;
  }

  /**
   * Ingest documents into the RAG vector store for an agent.
   */
  async ingest({ agentId, source }: IngestOptions): Promise<{ jobId: string | undefined }> {
    const job = await this.ingestQueue.add("ingest", {
      agentId,
      source,
    });
    return { jobId: job.id };
  }

  /**
   * Wait for an aggregator job to complete. The aggregator resumes the graph directly and returns the result (no agent resume job).
   */
  private async waitForAggregatorJobResult(aggregatorJobId: string, ttl: number): Promise<AgentJobResult> {
    const job = await this.aggregatorQueue.getJob(aggregatorJobId);
    if (!job) return { status: "completed" };
    const returnvalue = await job.waitUntilFinished(this.aggregatorQueueEvents, ttl);
    const parsed =
      typeof returnvalue === "string" ? (JSON.parse(returnvalue) as AgentJobResult) : (returnvalue as AgentJobResult);
    return parsed ?? { status: "completed" };
  }

  /**
   * Get an agent-queue job by id.
   */
  getAgentJob(jobId: string) {
    return this.agentQueue.getJob(jobId);
  }

  /**
   * Subscribe to progress events for a job. Returns unsubscribe. Listener is auto-removed when job completes or fails.
   */
  private subscribeToJobProgress(jobId: string, onProgress: (progress: JobProgress) => void): () => void {
    const progressHandler = (args: { jobId: string; data: unknown }, _id?: string) => {
      if (args.jobId === jobId) onProgress(args.data as JobProgress);
    };
    const remove = () => {
      this.agentQueueEvents.off("progress", progressHandler);
      this.agentQueueEvents.off("completed", completedHandler);
      this.agentQueueEvents.off("failed", failedHandler);
    };
    const completedHandler = ({ jobId: id }: { jobId: string }) => {
      if (id === jobId) remove();
    };
    const failedHandler = ({ jobId: id }: { jobId: string }) => {
      if (id === jobId) remove();
    };
    this.agentQueueEvents.on("progress", progressHandler);
    this.agentQueueEvents.on("completed", completedHandler);
    this.agentQueueEvents.on("failed", failedHandler);
    return remove;
  }

}
