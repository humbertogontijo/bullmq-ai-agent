import type { SystemMessageFields } from "@langchain/core/messages";
import { Job } from "bullmq";
import type { Redis } from "ioredis";
import { z } from "zod";
import type { AgentMemoryStore } from "./memory/AgentMemoryStore.js";
import type { TodoItem } from "./queues/types.js";

/** Callback signature for providing initial todos per run. */
export type GetTodosCallback = (ctx: {
  agentId: string;
  threadId: string;
  contactId?: string;
  metadata?: Record<string, unknown>;
}) => TodoItem[] | Promise<TodoItem[]>;

export interface AgentWorkerLogger {
  error: (msg: string, err?: Error) => void;
  warn: (msg: string) => void;
  debug: (msg: string) => void;
}

/** Default logger using console. Used by BullMQAgentWorker when no logger is passed. */
export function createDefaultAgentWorkerLogger(): AgentWorkerLogger {
  return {
    error: (msg, err) => console.error(msg, err),
    warn: (msg) => console.warn(msg),
    debug: (msg) => console.debug(msg),
  };
}

/** Minimal Redis interface for thread history and job tracking. Allows mocks in tests. */
export type RedisLike = Pick<Redis, "eval" | "zadd">;

/** Default queue name values (agent, ingest, search). */
export const QUEUE_NAMES = {
  AGENT: "agent",
  INGEST: "ingest",
  SEARCH: "search",
} as const;

/** Chat or embedding model configuration (provider, model id, api key). Pass apiKey from the caller (e.g. CLI); library does not read process.env. */
export interface ModelOptions {
  provider: string;
  model: string;
  apiKey: string;
  /** Optional; used when creating chat model (e.g. initChatModel). */
  temperature?: number;
  /** Optional; used when creating chat model. */
  maxTokens?: number;
}

/** Per-agent configuration (persona, default model). Loaded by getAgentConfig(agentId) and merged with run's chatModelOptions. */
export interface AgentConfig {
  /** Persona + instructions; prepended to messages at invoke time. */
  systemPrompt?: SystemMessageFields | SystemMessageFields[];
  /** Default model for this agent; run's chatModelOptions override. */
  model?: ModelOptions;
  /** Default temperature; run can override if passed. */
  temperature?: number;
  /** Default max tokens; run can override. */
  maxTokens?: number;
}

/**
 * Schema for per-run context passed in graph configurable and via config.context to middlewares.
 * This is the stable contract for the agent worker: tools and getAgentConfig receive this via configurable.
 * Do not remove or rename fields without updating the worker and all tools that read from configurable.
 */
export const runContextContextSchema = z.object({
  /** Current BullMQ job; used by progress middleware and for job metadata. */
  job: z.custom<Job>(),
  /** Agent id for this run (e.g. tenant or bot id). */
  agentId: z.string(),
  /** Thread id (conversation id). Used for history and jobId format threadId/<snowflake>. */
  thread_id: z.string(),
  /** Contact id (end-user identity). Scopes per-contact memories so personal data never leaks across users. */
  contactId: z.string(),
  /** When set, the runnable for this subagent is used directly. */
  subagentId: z.string().optional(),
  /** Chat model options for this run (merged from worker default + getAgentConfig). */
  chatModelOptions: z.any().optional(),
  /** Embedding model options (for retrieve tool and RAG). */
  embeddingModelOptions: z.custom<ModelOptions>().optional(),
  /** Optional metadata from run/resume job data. CRM can pass owner, tenant, etc.; tools and getAgentConfig can read it. */
  metadata: z.record(z.unknown()).optional(),
  /** Redis client; set by worker so history middleware can load thread history. */
  redis: z.custom<RedisLike>().optional(),
  /** BullMQ queue key prefix; used by history middleware. */
  queueKeyPrefix: z.string().optional(),
  /** When set, passed to getPreviousReturnvalues Lua as max number of previous jobs to load (limits history size). */
  maxHistoryMessages: z.number().optional(),
  /** Cross-thread memory store scoped by agentId. Set by worker when enableAgentMemory is on. */
  agentMemoryStore: z.custom<AgentMemoryStore>().optional(),
  /** Callback returning initial required todos for the agent. Used by TodoPersistenceMiddleware. */
  getTodos: z.custom<GetTodosCallback>().optional(),
});

/** Per-run data passed in graph configurable. Type derived from runContextContextSchema. */
export type RunContext = z.infer<typeof runContextContextSchema>;

/**
 * Build RunContext for a single job. Use in the agent worker so context shape and defaults live in one place.
 */
export function buildRunContext(params: {
  job: Job;
  agentId: string;
  thread_id: string;
  contactId: string;
  subagentId?: string;
  chatModelOptions?: ModelOptions;
  embeddingModelOptions?: ModelOptions;
  metadata?: Record<string, unknown>;
  redis?: RedisLike;
  queueKeyPrefix?: string;
  maxHistoryMessages?: number;
  agentMemoryStore?: AgentMemoryStore;
  getTodos?: GetTodosCallback;
}): RunContext {
  return {
    job: params.job,
    agentId: params.agentId,
    thread_id: params.thread_id,
    contactId: params.contactId,
    subagentId: params.subagentId,
    chatModelOptions: params.chatModelOptions,
    embeddingModelOptions: params.embeddingModelOptions,
    metadata: params.metadata,
    redis: params.redis,
    queueKeyPrefix: params.queueKeyPrefix,
    maxHistoryMessages: params.maxHistoryMessages,
    agentMemoryStore: params.agentMemoryStore,
    getTodos: params.getTodos,
  };
}
