import type { StoredMessage } from "@langchain/core/messages";
import type { Queue, QueueOptions } from "bullmq";
import { QueueEvents } from "bullmq";
import { QUEUE_NAMES } from "./options.js";
import { createAgentQueue } from "./queues/agentQueue.js";
import { createIngestQueue } from "./queues/ingestQueue.js";
import type { AgentJobData, AgentJobResult, IngestJobData, InterruptPayload, ResumeData } from "./queues/types.js";

export type MessageRole = "user" | "assistant" | "system";

/** Progress payload from BullMQ job (worker calls job.updateProgress). */
export interface JobProgress {
  stage: string;
  [key: string]: unknown;
}

export interface RunOptions {
  /** Subagent name; when set, that subagent runs directly (must match a subagent name from BullMQAgentWorker options). */
  subagentId?: string;
  /** Initial messages (e.g. [{ role: "user", content: "Hello" }]). */
  messages: StoredMessage[];
  /** Called when the worker reports progress (e.g. graph node stage). Uses BullMQ job progress. */
  onProgress?: (progress: JobProgress) => void;
  /** Optional run-level metadata (e.g. owner, tenant). Passed to configurable so tools and getAgentConfig can read it. */
  metadata?: Record<string, unknown>;
}

export interface ResumeOptions {
  /** Pass when resuming so the same runnable (main or subagent) is used. From interruptPayload. */
  subagentId?: string;
  /** Called when the worker reports progress. */
  onProgress?: (progress: JobProgress) => void;
  /** Optional run-level metadata. Passed to configurable so tools and getAgentConfig can read it. */
  metadata?: Record<string, unknown>;
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
 * Tools run in-process; call close() when done.
 */
export class BullMQAgentClient {
  private readonly options: QueueOptions;
  private readonly agentQueue: Queue<AgentJobData>;
  private readonly ingestQueue: Queue<IngestJobData>;
  private readonly agentQueueEvents: QueueEvents;

  constructor(options: QueueOptions) {
    this.options = options;
    this.agentQueue = createAgentQueue({ ...this.options });
    this.ingestQueue = createIngestQueue({ ...this.options });
    this.agentQueueEvents = new QueueEvents(QUEUE_NAMES.AGENT, { ...this.options });
  }

  /**
   * Close all queue connections.
   */
  async close(): Promise<void> {
    await Promise.all([
      this.agentQueueEvents.close(),
      this.agentQueue.close(),
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
      subagentId: options.subagentId,
      metadata: options.metadata,
      input: { messages },
    });
    if (options.onProgress && job.id) {
      this.subscribeToJobProgress(job.id, options.onProgress);
    }
    return { agentId, threadId, jobId: job.id };
  }

  /**
   * Run and wait for the job to complete (or human-in-the-loop interrupt).
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
    return job.waitUntilFinished(this.agentQueueEvents, ttl);
  }

  /**
   * Resume a run after a human-in-the-loop interrupt (fire-and-forget).
   * Pass interruptPayload from the previous run so the worker uses the same runnable (subagentId + chatModelOptions).
   */
  async resume(
    agentId: string,
    threadId: string,
    result: ResumeData,
    options: ResumeOptions = {}
  ): Promise<{ jobId: string | undefined }> {
    const job = await this.agentQueue.add("resume", {
      agentId,
      threadId,
      result,
      subagentId: options.subagentId,
      metadata: options.metadata,
    });
    if (options.onProgress && job.id) {
      this.subscribeToJobProgress(job.id, options.onProgress);
    }
    return { jobId: job.id };
  }

  /**
   * Resume and wait for the job to complete (or next interrupt).
   */
  async resumeAndWait(
    agentId: string,
    threadId: string,
    result: ResumeData,
    options: ResumeOptions = {},
    ttl: number = defaultWaitTtl
  ): Promise<AgentJobResult> {
    const job = await this.agentQueue.add("resume", {
      agentId,
      threadId,
      result,
      subagentId: options.subagentId,
      metadata: options.metadata,
    });
    if (options.onProgress && job.id) {
      this.subscribeToJobProgress(job.id, options.onProgress);
    }
    if (!job.id) return { status: "completed" };
    const fullJob = await this.agentQueue.getJob(job.id);
    if (!fullJob) return { status: "completed" };
    return fullJob.waitUntilFinished(this.agentQueueEvents, ttl);
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
