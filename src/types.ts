import type { TObject, Static } from '@sinclair/typebox';
import type { ConnectionOptions } from 'bullmq';

// ---------------------------------------------------------------------------
// User-facing: Tools & Goals
// ---------------------------------------------------------------------------

export interface AgentTool<T extends TObject = TObject> {
  name: string;
  description: string;
  schema: T;
  handler: (
    args: Static<T>,
    context?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAgentTool = AgentTool<any>;

export interface AgentGoal {
  id: string;
  agentName: string;
  agentFriendlyDescription: string;
  description: string;
  tools: AnyAgentTool[];
  systemMessage?: string;
}

// ---------------------------------------------------------------------------
// Serialized LangChain messages (stored in BullMQ job returnvalue)
// ---------------------------------------------------------------------------

export interface SerializedMessage {
  role: 'system' | 'human' | 'ai' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: SerializedToolCall[];
}

export interface SerializedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Job data types
// ---------------------------------------------------------------------------

export type JobType = 'prompt' | 'confirm' | 'end-chat';

/** Data for orchestrator / single-agent queue jobs (created by the client). */
export interface OrchestratorJobData {
  sessionId: string;
  type: JobType;
  prompt?: string;
  /** Optional context passed through to tool handlers. */
  context?: Record<string, unknown>;
}

/** Data for per-agent child jobs (created by the orchestrator worker). */
export interface AgentChildJobData {
  sessionId: string;
  goalId: string;
  prompt?: string;
  /** Carried over from a previous awaiting-confirm result on `confirm`. */
  toolCalls?: ToolCall[];
  /** Optional context passed through to tool handlers. */
  context?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Job result types
// ---------------------------------------------------------------------------

export interface AgentChildResult {
  goalId: string;
  /** Delta: only the new messages produced during this agent step. */
  messages: SerializedMessage[];
  status: 'complete' | 'awaiting-confirm';
}

/**
 * Unified result stored by the orchestrator step.
 * In single-goal mode this IS the agent result.
 * In multi-goal mode it wraps the aggregator output.
 *
 * `routing` means the orchestrator dispatched work to agent children
 * and the real result will arrive from the aggregator — clients should
 * ignore this intermediate status.
 */
export interface StepResult {
  /** New messages produced during this step only (delta, not cumulative). */
  history: SerializedMessage[];
  goalId?: string;
  toolCalls?: ToolCall[];
  agentResults?: Record<string, AgentChildResult>;
  status: 'active' | 'awaiting-confirm' | 'ended' | 'routing';
  /** Set when status is 'routing' — the aggregator job ID to follow. */
  routingJobId?: string;
}

// ---------------------------------------------------------------------------
// Tool-related types
// ---------------------------------------------------------------------------

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  goalId: string;
}

// ---------------------------------------------------------------------------
// Configuration options
// ---------------------------------------------------------------------------

/**
 * Controls how long completed/failed BullMQ jobs are kept in Redis.
 * - `age`   — max seconds to keep a finished job (default 3600 = 1 hour).
 * - `count` — max number of finished jobs to keep per queue (default 200).
 */
export interface JobRetention {
  age?: number;
  count?: number;
}

export const DEFAULT_JOB_RETENTION: Required<JobRetention> = {
  age: 3600,
  count: 200,
};

export interface AgentWorkerLogger {
  error: (msg: string, err?: Error) => void;
  warn?: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface AgentWorkerOptions {
  connection: ConnectionOptions;
  /**
   * Optional logger for worker errors, warnings, and debug messages.
   */
  logger?: AgentWorkerLogger;
  /**
   * Optional prefix for queue names. When set, prepended to orchestrator, agent, and aggregator queue names (default empty).
   */
  queuePrefix?: string;
  /**
   * LLM configuration passed to langchain's `initChatModel`.
   * Supports any provider with the corresponding `@langchain/*` package installed.
   *
   * @example
   * // OpenAI  (requires @langchain/openai)
   * { model: "openai:gpt-4o", apiKey: "sk-..." }
   *
   * // Anthropic  (requires @langchain/anthropic)
   * { model: "anthropic:claude-3-5-sonnet-latest", apiKey: "sk-ant-..." }
   *
   * // Explicit provider
   * { model: "gpt-4o", modelProvider: "openai", temperature: 0.2 }
   */
  llm: {
    /** Model identifier. Supports "provider:model" format (e.g. "openai:gpt-4o"). */
    model: string;
    /** Explicit provider name. Optional when provider is embedded in the model string. */
    modelProvider?: string;
    /** API key for the provider. Can also be set via env var (e.g. OPENAI_API_KEY). */
    apiKey?: string;
    /** Any additional options forwarded to initChatModel (temperature, maxTokens, etc.). */
    [key: string]: unknown;
  };
  goals: AgentGoal[];
  /** Require user confirmation before executing tools. Default `true`. */
  showConfirmation?: boolean;
}

export interface AgentClientOptions {
  connection: ConnectionOptions;
  /** How long to keep completed/failed result jobs in Redis. */
  jobRetention?: JobRetention;
  /** Optional prefix for queue names. Must match the worker's queuePrefix. */
  queuePrefix?: string;
}

// ---------------------------------------------------------------------------
// Client helpers
// ---------------------------------------------------------------------------

export interface AgentResponseEvent {
  goalId: string;
  text: string;
}

// ---------------------------------------------------------------------------
// Queue name constants
// ---------------------------------------------------------------------------

export const ORCHESTRATOR_QUEUE = 'agent-orchestrator';
export const AGENT_QUEUE = 'agent-worker';
export const AGGREGATOR_QUEUE = 'agent-aggregator';

/** Resolve queue name with optional prefix (default empty for backward compatibility). */
export function getQueueName(prefix: string | undefined, base: string): string {
  return (prefix ?? '') + base;
}
