import type { FlowChildJob, Queue, QueueOptions } from "bullmq";
import { QueueEvents } from "bullmq";
import { QUEUE_NAMES } from "./options.js";
import { snowflake } from "./utils/snowflake.js";
import { createAgentQueue } from "./queues/agentQueue.js";
import { createIngestQueue } from "./queues/ingestQueue.js";
import { createSearchQueue } from "./queues/searchQueue.js";
import type { AgentJobData, AgentJobResult, AgentResumeToolData, AgentRunData, IngestJobData, IngestJobResult, SearchJobData, SearchJobResult, StoredMessage } from "./queues/types.js";

export type MessageRole = "user" | "assistant" | "system";

/** Progress payload from BullMQ job (worker calls job.updateProgress). */
export interface JobProgress {
  stage: string;
  [key: string]: unknown;
}

export interface AwaitableOptions {
  /** Called when the worker reports progress (e.g. graph node stage). Uses BullMQ job progress. */
  onProgress?: (progress: JobProgress) => void;
  /** Time-to-live (ms) when awaiting the result. Default 120_000. */
  ttl?: number;
}

/** Options for buildRunFlowChild: no waiting; used to build a flow child node. */
export interface RunFlowChildOptions {
  /** Initial messages (StoredMessage[], e.g. [{ type: "human", data: { content: "Hello" } }]). */
  messages: StoredMessage[];
  /** Subagent name; when set, that subagent runs directly (must match a subagent name from BullMQAgentWorker options). */
  subagentId?: string;
  /** Optional run-level metadata (e.g. owner, tenant). Passed to configurable so tools and getAgentConfig can read it. */
  metadata?: Record<string, unknown>;
}

/** Options for run(); extends RunFlowChildOptions with await-specific options. */
export interface RunOptions extends RunFlowChildOptions, AwaitableOptions {
}

/** Options for buildResumeToolFlowChild: no waiting; used to build a flow child node. */
export interface ResumeToolFlowChildOptions {
  /** Human response content for the request_human_approval tool. */
  content: string;
  /** Pass when resuming so the same runnable (main or subagent) is used. */
  subagentId?: string;
  /** Optional run-level metadata. */
  metadata?: Record<string, unknown>;
}

/** Options for resumeTool(); extends ResumeToolFlowChildOptions with await-specific options. */
export interface ResumeToolOptions extends ResumeToolFlowChildOptions, AwaitableOptions { }

/**
 * Flow child spec for an agent "run" job. Use as a child in FlowProducer.add() so the agent runs
 * as part of your flow; when it completes, the parent job runs and can read the AI result via getChildrenValues().
 * Use the same Redis connection and prefix for your FlowProducer as for BullMQAgentClient.
 */
export interface AgentRunFlowChild extends FlowChildJob {
  name: "run";
  queueName: string;
  data: AgentRunData;
  opts?: { jobId: string };
}

/**
 * Flow child spec for an agent "resumeTool" job. Use as a child in FlowProducer.add().
 */
export interface AgentResumeToolFlowChild extends FlowChildJob {
  name: "resumeTool";
  queueName: string;
  data: AgentResumeToolData;
  opts?: { jobId: string };
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
  /** Time-to-live (ms) when awaiting the result. Default 120_000. */
  ttl?: number;
}

const defaultWaitTtl = 120_000; // 2 minutes

/**
 * Subscribe to progress events for a job on a queue. Returns an unsubscribe function; the subscription
 * is also cleared automatically when the job completes or fails.
 */
function subscribeToProgress(
  queueEvents: QueueEvents,
  jobId: string,
  onProgress: (progress: JobProgress) => void
): () => void {
  const progressHandler = (args: { jobId: string; data: unknown }, _id?: string) => {
    if (args.jobId === jobId) onProgress(args.data as JobProgress);
  };
  const remove = () => {
    queueEvents.off("progress", progressHandler);
    queueEvents.off("completed", completedHandler);
    queueEvents.off("failed", failedHandler);
  };
  const completedHandler = ({ jobId: id }: { jobId: string }) => {
    if (id === jobId) remove();
  };
  const failedHandler = ({ jobId: id }: { jobId: string }) => {
    if (id === jobId) remove();
  };
  queueEvents.on("progress", progressHandler);
  queueEvents.on("completed", completedHandler);
  queueEvents.on("failed", failedHandler);
  return remove;
}

/** Meta attached to a client result (jobId). */
export interface ClientResultMeta {
  jobId: string | undefined;
}

/**
 * Thrown when awaiting a ClientResult and the job ID is missing or the job was not found.
 * Catch this error to handle "no_job" or "job_not_found" cases.
 */
export class ClientResultError extends Error {
  readonly status: "no_job" | "job_not_found";

  constructor(status: "no_job" | "job_not_found", message: string) {
    super(message);
    this.name = "ClientResultError";
    this.status = status;
    Object.setPrototypeOf(this, ClientResultError.prototype);
  }
}

/** Queue-like type used by ClientResult to get a job and wait for it. */
export interface ClientResultQueueLike {
  getJob(id: string): Promise<{ waitUntilFinished(events: QueueEvents, ttl: number): Promise<unknown> } | null | undefined>;
}

/**
 * Result for run/resume/ingest. Holds queue and queueEvents and handles waiting internally.
 * Use .jobId and await .promise for the job result. TTL is fixed at creation (pass ttl in run/resume/ingest/search options).
 * When jobId is missing or the job is not found, the promise rejects with ClientResultError.
 * When onProgress is provided, ClientResult owns the progress subscription and unsubscribes when the promise settles.
 */
export class ClientResult<T> {
  readonly jobId: string | undefined;
  private readonly _queue: ClientResultQueueLike;
  private readonly _queueEvents: QueueEvents;
  private readonly _ttl: number;
  private _unsubscribeProgress: (() => void) | undefined;
  promise: Promise<T>;

  constructor(
    queue: ClientResultQueueLike,
    queueEvents: QueueEvents,
    meta: ClientResultMeta,
    ttl: number = defaultWaitTtl,
    onProgress?: (progress: JobProgress) => void
  ) {
    const safeMeta = meta ?? { jobId: undefined };
    this._queue = queue;
    this._queueEvents = queueEvents;
    this._ttl = ttl;
    this.jobId = safeMeta.jobId;
    this._unsubscribeProgress = undefined;
    if (this.jobId && onProgress) {
      this._unsubscribeProgress = subscribeToProgress(this._queueEvents, this.jobId, onProgress);
    }
    this.promise = this._wait();
  }

  private async _wait(): Promise<T> {
    try {
      if (!this.jobId) {
        throw new ClientResultError("no_job", "Job ID is missing");
      }
      const job = await this._queue.getJob(this.jobId);
      if (!job) {
        throw new ClientResultError("job_not_found", `Job ${this.jobId} not found`);
      }
      return (await job.waitUntilFinished(this._queueEvents, this._ttl)) as T;
    } finally {
      this._unsubscribeProgress?.();
      this._unsubscribeProgress = undefined;
    }
  }
}

/** Result of run(); use .jobId and await .promise for AgentJobResult (throws ClientResultError if no job or not found). */
export type RunResult = ClientResult<AgentJobResult>;

/** Result of resumeTool(); use .jobId and await .promise (throws ClientResultError if no job or not found). */
export type ResumeResult = ClientResult<AgentJobResult>;

/** Result of ingest(); use .jobId and await .promise (throws ClientResultError if no job or not found). */
export type IngestResult = ClientResult<IngestJobResult>;

/** Result of searchKnowledge(); use .jobId and await .promise (throws ClientResultError if no job or not found). */
export type SearchResult = ClientResult<SearchJobResult>;

export interface SearchKnowledgeOptions {
  /** Number of results to return (default 5). */
  k?: number;
  /** Time-to-live (ms) when awaiting the result. Default 120_000. */
  ttl?: number;
}

/** Client options: QueueOptions. Thread index (for history) is maintained by the worker when it processes jobs. */
export interface BullMQAgentClientOptions extends QueueOptions { }

/**
 * Client for invoking the BullMQ agent: start runs, resume after human-in-the-loop, and ingest documents for RAG.
 * Tools run in-process; call close() when done.
 */
export class BullMQAgentClient {
  private readonly options: QueueOptions;
  private readonly agentQueue: Queue<AgentJobData, AgentJobResult>;
  private readonly ingestQueue: Queue<IngestJobData>;
  private readonly searchQueue: Queue<SearchJobData>;
  private readonly agentQueueEvents: QueueEvents;
  private readonly ingestQueueEvents: QueueEvents;
  private readonly searchQueueEvents: QueueEvents;

  constructor(options: BullMQAgentClientOptions) {
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
   * Start a new agent run. Returns ClientResult<AgentJobResult>: await it for the job result.
   * Pass ttl in options to set wait timeout (ms). When jobId is missing or job not found, the promise rejects with ClientResultError.
   */
  async run(
    agentId: string,
    threadId: string,
    options: RunOptions
  ): Promise<RunResult> {
    const spec = this.buildRunFlowChild(agentId, threadId, {
      messages: options.messages,
      subagentId: options.subagentId,
      metadata: options.metadata,
    });
    const job = await this.agentQueue.add(spec.name, spec.data, spec.opts);
    const resolvedJobId = job.id ?? spec.opts?.jobId;
    return new ClientResult<AgentJobResult>(
      this.agentQueue,
      this.agentQueueEvents,
      { jobId: resolvedJobId },
      options.ttl ?? defaultWaitTtl,
      options.onProgress
    );
  }

  /**
   * Resume after human-in-the-loop by sending only the human response content. The worker fetches the last
   * executed job for the thread, builds the tool message with the last AI message's tool_call_id, and runs the graph.
   * Returns ClientResult<AgentJobResult>. Requires a previous run for this thread (job registered in thread-jobs set).
   */
  async resumeTool(
    agentId: string,
    threadId: string,
    options: ResumeToolOptions
  ): Promise<ResumeResult> {
    const spec = this.buildResumeToolFlowChild(agentId, threadId, {
      content: options.content,
      subagentId: options.subagentId,
      metadata: options.metadata,
    });
    const job = await this.agentQueue.add(spec.name, spec.data, spec.opts);
    const resolvedJobId = job.id ?? spec.opts?.jobId;
    return new ClientResult<AgentJobResult>(
      this.agentQueue,
      this.agentQueueEvents,
      { jobId: resolvedJobId },
      options.ttl ?? defaultWaitTtl,
      options.onProgress
    );
  }

  /**
   * Build a flow child node for a new agent run. Use this as a child in FlowProducer.add() so the agent
   * runs as part of your BullMQ flow; when the agent job completes, the parent job runs and can read
   * the AI result via job.getChildrenValues(). Use the same connection and prefix for your FlowProducer
   * as for this client. Does not add any job to the queue — the job is created when the flow is added.
   * To listen to progress for the agent job, use the jobId from the child's opts (or from the flow result)
   * with subscribeToAgentProgress(jobId, onProgress).
   */
  buildRunFlowChild(agentId: string, threadId: string, options: RunFlowChildOptions): AgentRunFlowChild {
    const jobId = `${threadId}/${snowflake()}`;
    return {
      name: "run",
      queueName: QUEUE_NAMES.AGENT,
      data: {
        agentId,
        threadId,
        subagentId: options.subagentId,
        metadata: options.metadata,
        input: { messages: options.messages },
      },
      opts: { jobId },
    };
  }

  /**
   * Build a flow child node for resumeTool (human-in-the-loop response). Use as a child in FlowProducer.add().
   * When the flow is added, the agent job is created; when it completes, the parent runs with getChildrenValues().
   * To listen to progress for the agent job, use the jobId from the child's opts with subscribeToAgentProgress(jobId, onProgress).
   */
  buildResumeToolFlowChild(agentId: string, threadId: string, options: ResumeToolFlowChildOptions): AgentResumeToolFlowChild {
    const jobId = `${threadId}/${snowflake()}`;
    return {
      name: "resumeTool",
      queueName: QUEUE_NAMES.AGENT,
      data: {
        agentId,
        threadId,
        content: options.content,
        subagentId: options.subagentId,
        metadata: options.metadata,
      },
      opts: { jobId },
    };
  }

  /**
   * Ingest documents into the RAG vector store for an agent. Returns ClientResult<IngestJobResult>:
   * await for the ingest result. Pass ttl in options to set wait timeout (ms).
   * When jobId is missing or job not found, the promise rejects with ClientResultError.
   */
  async ingest({ agentId, source, ttl }: IngestOptions): Promise<IngestResult> {
    const job = await this.ingestQueue.add("ingest", {
      agentId,
      source,
    });
    return new ClientResult<IngestJobResult>(
      this.ingestQueue,
      this.ingestQueueEvents,
      { jobId: job.id },
      ttl ?? defaultWaitTtl
    );
  }

  /**
   * Run similarity search over the RAG vector store for an agent. Returns ClientResult<SearchJobResult>:
   * await for the search result (results and count). Pass ttl in options to set wait timeout (ms).
   * When jobId is missing or job not found, the promise rejects with ClientResultError.
   */
  async searchKnowledge(
    agentId: string,
    query: string,
    options: SearchKnowledgeOptions = {}
  ): Promise<SearchResult> {
    const { k = 5, ttl } = options;
    const job = await this.searchQueue.add("search", {
      agentId,
      query,
      k,
    });
    return new ClientResult<SearchJobResult>(
      this.searchQueue,
      this.searchQueueEvents,
      { jobId: job.id },
      ttl ?? defaultWaitTtl
    );
  }

  /**
   * Subscribe to progress events for an agent job by id. Use this when the job was enqueued via a flow
   * (e.g. using buildRunFlowChild or buildResumeToolFlowChild) and you have the jobId from the flow.
   * Returns an unsubscribe function; the subscription is also cleared automatically when the job
   * completes or fails.
   */
  subscribeToAgentProgress(jobId: string, onProgress: (progress: JobProgress) => void): () => void {
    return subscribeToProgress(this.agentQueueEvents, jobId, onProgress);
  }

  /**
   * Get an agent-queue job by id.
   */
  getAgentJob(jobId: string) {
    return this.agentQueue.getJob(jobId);
  }
}
