import type { StoredMessage } from "@langchain/core/messages";
import type { Queue, QueueOptions } from "bullmq";
import { QueueEvents } from "bullmq";
import { QUEUE_NAMES } from "./options.js";
import { createAgentQueue } from "./queues/agentQueue.js";
import { createIngestQueue } from "./queues/ingestQueue.js";
import { createSearchQueue } from "./queues/searchQueue.js";
import type { AgentJobData, AgentJobResult, IngestJobData, IngestJobResult, InterruptPayload, ResumeData, SearchJobData, SearchJobResult } from "./queues/types.js";

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

const defaultWaitTtl = 120_000; // 2 minutes

/** Meta attached to a client result (jobId; agentId/threadId for run). */
export interface ClientResultMeta {
  jobId: string | undefined;
  agentId?: string;
  threadId?: string;
}

/**
 * Fallback result when the client result has no jobId or the job was not found.
 * Use this interface to narrow await results: check status === "no_job" | "job_not_found".
 */
export interface AwaitableResultFallback {
  status: "no_job" | "job_not_found";
  message?: string;
}

/** Resolved type when awaiting a ClientResult: the job result T or a fallback when jobId is missing or job not found. */
export type ClientResultResolved<T> = T | AwaitableResultFallback;

/** Queue-like type used by ClientResult to get a job and wait for it. */
export interface ClientResultQueueLike {
  getJob(id: string): Promise<{ waitUntilFinished(events: QueueEvents, ttl: number): Promise<unknown> } | null | undefined>;
}

/**
 * Result for run/resume/ingest. Holds queue and queueEvents and handles waiting internally.
 * Use .jobId (and .agentId/.threadId for run) without awaiting. Call .wait(ttl?) to get a Promise
 * for the job result. When jobId is missing or the job is not found, the promise resolves to
 * AwaitableResultFallback (status "no_job" or "job_not_found") so you can handle it explicitly.
 */
export class ClientResult<T> {
  readonly jobId: string | undefined;
  readonly agentId?: string;
  readonly threadId?: string;
  private readonly _queue: ClientResultQueueLike;
  private readonly _queueEvents: QueueEvents;
  private readonly _defaultTtl: number;

  constructor(
    queue: ClientResultQueueLike,
    queueEvents: QueueEvents,
    meta: ClientResultMeta,
    defaultTtl: number = defaultWaitTtl
  ) {
    const safeMeta = meta ?? { jobId: undefined };
    this._queue = queue;
    this._queueEvents = queueEvents;
    this._defaultTtl = defaultTtl;
    this.jobId = safeMeta.jobId;
    this.agentId = safeMeta.agentId;
    this.threadId = safeMeta.threadId;
  }

  private async _wait(ttl: number): Promise<ClientResultResolved<T>> {
    if (!this.jobId) {
      return { status: "no_job", message: "Job ID is missing" };
    }
    const job = await this._queue.getJob(this.jobId);
    if (!job) {
      return { status: "job_not_found", message: `Job ${this.jobId} not found` };
    }
    return (await job.waitUntilFinished(this._queueEvents, ttl)) as T;
  }

  /** Wait for the job to complete with optional custom TTL (ms). Resolves to T or AwaitableResultFallback. */
  wait(ttl?: number): Promise<ClientResultResolved<T>> {
    return this._wait(ttl ?? this._defaultTtl);
  }
}

/** Result of run(); await for AgentJobResult or fallback; use .jobId / .agentId / .threadId. */
export type RunResult = ClientResult<AgentJobResult>;

/** Result of resume(); await for AgentJobResult or fallback; use .jobId. */
export type ResumeResult = ClientResult<AgentJobResult>;

/** Result of ingest(); await for IngestJobResult or fallback; use .jobId. */
export type IngestResult = ClientResult<IngestJobResult>;

/** Result of searchKnowledge(); await for SearchJobResult or fallback; use .jobId. */
export type SearchResult = ClientResult<SearchJobResult>;

export interface SearchKnowledgeOptions {
  /** Number of results to return (default 5). */
  k?: number;
}

/**
 * Client for invoking the BullMQ agent: start runs, resume after human-in-the-loop, and ingest documents for RAG.
 * Tools run in-process; call close() when done.
 */
export class BullMQAgentClient {
  private readonly options: QueueOptions;
  private readonly agentQueue: Queue<AgentJobData>;
  private readonly ingestQueue: Queue<IngestJobData>;
  private readonly searchQueue: Queue<SearchJobData>;
  private readonly agentQueueEvents: QueueEvents;
  private readonly ingestQueueEvents: QueueEvents;
  private readonly searchQueueEvents: QueueEvents;

  constructor(options: QueueOptions) {
    this.options = options;
    this.agentQueue = createAgentQueue({ ...this.options });
    this.ingestQueue = createIngestQueue({ ...this.options });
    this.searchQueue = createSearchQueue({ ...this.options });
    this.agentQueueEvents = new QueueEvents(QUEUE_NAMES.AGENT, { ...this.options });
    this.ingestQueueEvents = new QueueEvents(QUEUE_NAMES.INGEST, { ...this.options });
    this.searchQueueEvents = new QueueEvents(QUEUE_NAMES.SEARCH, { ...this.options });
  }

  /**
   * Close all queue connections.
   */
  async close(): Promise<void> {
    await Promise.all([
      this.agentQueueEvents.close(),
      this.ingestQueueEvents.close(),
      this.searchQueueEvents.close(),
      this.agentQueue.close(),
      this.ingestQueue.close(),
      this.searchQueue.close(),
    ]);
  }

  /**
   * Start a new agent run. Returns ClientResult<AgentJobResult>: await it for the job result (default TTL),
   * or use .jobId / .agentId / .threadId and optionally .wait(ttl) for custom TTL.
   * When jobId is missing or job not found, the awaited value is AwaitableResultFallback.
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
    return new ClientResult<AgentJobResult>(
      this.agentQueue,
      this.agentQueueEvents,
      { jobId: job.id, agentId, threadId },
      defaultWaitTtl
    );
  }

  /**
   * Resume a run after a human-in-the-loop interrupt. Returns ClientResult<AgentJobResult>: await for
   * the job result or use .jobId and .wait(ttl?) for custom TTL.
   * When jobId is missing or job not found, the awaited value is AwaitableResultFallback.
   */
  async resume(
    agentId: string,
    threadId: string,
    result: ResumeData,
    options: ResumeOptions = {}
  ): Promise<ResumeResult> {
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
    return new ClientResult<AgentJobResult>(
      this.agentQueue,
      this.agentQueueEvents,
      { jobId: job.id },
      defaultWaitTtl
    );
  }

  /**
   * Ingest documents into the RAG vector store for an agent. Returns ClientResult<IngestJobResult>:
   * await for the ingest result or use .jobId and .wait(ttl?) for custom TTL.
   * When jobId is missing or job not found, the awaited value is AwaitableResultFallback.
   */
  async ingest({ agentId, source }: IngestOptions): Promise<IngestResult> {
    const job = await this.ingestQueue.add("ingest", {
      agentId,
      source,
    });
    return new ClientResult<IngestJobResult>(
      this.ingestQueue,
      this.ingestQueueEvents,
      { jobId: job.id },
      defaultWaitTtl
    );
  }

  /**
   * Run similarity search over the RAG vector store for an agent. Returns ClientResult<SearchJobResult>:
   * await for the search result (results and count) or use .jobId and .wait(ttl?) for custom TTL.
   * When jobId is missing or job not found, the awaited value is AwaitableResultFallback.
   */
  async searchKnowledge(
    agentId: string,
    query: string,
    options: SearchKnowledgeOptions = {}
  ): Promise<SearchResult> {
    const { k = 5 } = options;
    const job = await this.searchQueue.add("search", {
      agentId,
      query,
      k,
    });
    return new ClientResult<SearchJobResult>(
      this.searchQueue,
      this.searchQueueEvents,
      { jobId: job.id },
      defaultWaitTtl
    );
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
