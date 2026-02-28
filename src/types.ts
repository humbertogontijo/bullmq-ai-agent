import type { Static, TObject } from '@sinclair/typebox';
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

export type SerializedMessageRole = 'system' | 'human' | 'ai' | 'tool';

export interface SerializedMessage {
  role: SerializedMessageRole;
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
  /**
   * When set with type === 'prompt', use this goal only (no LLM routing).
   * Lets the webapp send "run conversation goal" vs "run analyze goal" explicitly.
   */
  goalId?: string;
  /**
   * Optional prefix messages. Worker always uses fetchSessionResults; when present,
   * message list is: deserialize(initialMessages) + session history + (if prompt) HumanMessage(prompt).
   */
  initialMessages?: SerializedMessage[];
  /** Optional context passed through to tool handlers. */
  context?: Record<string, unknown>;
  /**
   * Optional tool choice for this step. Passed to the LLM (e.g. "toolName", "auto", "any", "none").
   * Lets the caller enforce a specific tool when needed.
   */
  toolChoice?: string | Record<string, unknown> | 'auto' | 'any' | 'none';
  /**
   * When true, tools are executed automatically when the LLM requests them.
   * When omitted or false, user confirmation is required before executing tools.
   */
  autoExecuteTools?: boolean;
}

/** Data for per-agent child jobs (created by the orchestrator worker). */
export interface AgentChildJobData {
  sessionId: string;
  goalId: string;
  prompt?: string;
  /** Carried over from a previous awaiting-confirm result on `confirm`. */
  toolCalls?: ToolCall[];
  /** Optional prefix messages (passed from orchestrator job when present). */
  initialMessages?: SerializedMessage[];
  /** Optional context passed through to tool handlers. */
  context?: Record<string, unknown>;
  /** Optional tool choice (passed from orchestrator job when present). */
  toolChoice?: string | Record<string, unknown> | 'auto' | 'any' | 'none';
  /** When true, execute tools automatically; when omitted or false, require user confirmation. */
  autoExecuteTools?: boolean;
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

export interface AgentWorkerLlmConfigData {
  model: string;
  modelProvider?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  [key: string]: unknown;
}

export type AgentWorkerLlmConfig = (options: {
  goalId?: string;
  context?: Record<string, unknown>;
}) => Promise<AgentWorkerLlmConfigData>

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
   * Called at the start of each orchestrator/agent step. Returned config is passed
   * to langchain's `initChatModel`. Use for per-job, per-goal, or static LLM config.
   */
  llmConfig: AgentWorkerLlmConfig;
  goals: AgentGoal[];
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
