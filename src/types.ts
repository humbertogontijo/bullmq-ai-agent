import { Type, type Static, type TObject } from '@sinclair/typebox';
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

export interface AgentGoal {
  id: string;
  name: string;
  title: string;
  description: string;
  tools: AgentTool<any>[];
  systemMessage?: string;
}

// ---------------------------------------------------------------------------
// RAG & Agent (per-agent knowledge; goals are objectives)
// ---------------------------------------------------------------------------

/** Embedding provider config for RAG. Used for indexing and retrieval. */
export type EmbeddingConfig =
  | { provider: 'openai'; model?: string; apiKey?: string }
  | { provider: 'cohere'; model?: string; apiKey?: string };

/** Worker-level RAG options. When present on the worker (with embedding), RAG is enabled: document queue and retrieve tool use this config for all agents. */
export interface AgentWorkerRagOptions {
  /** Required when RAG is enabled. Used for indexing and retrieval. */
  embedding: EmbeddingConfig;
  /** Number of documents to retrieve (default 4). */
  topK?: number;
  /** Name of the retrieve tool (default 'retrieve'). */
  retrieveToolName?: string;
}

/** Source for addDocument: URL, file path, or raw text. */
export type DocumentSource =
  | { type: 'url'; url: string; metadata?: Record<string, unknown> }
  | { type: 'file'; path: string; metadata?: Record<string, unknown> }
  | { type: 'text'; text: string; metadata?: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Attachments (multimodal prompt content)
// ---------------------------------------------------------------------------

/**
 * Image, video, audio, or document (file) attachment using URL, base64 data, or provider file ID.
 * Compatible with LangChain ContentBlock.Multimodal (image, video, audio, file).
 */
export interface PromptAttachment {
  type: 'image' | 'video' | 'audio' | 'file';
  /** MIME type; recommended when using `data`, required by some providers for base64. */
  mimeType?: string;
  metadata?: Record<string, unknown>;
  /** Public or signed URL of the media/file. */
  url?: string;
  /** Base64-encoded data; when set, provide `mimeType` for best compatibility. */
  data?: string;
  /** Provider file ID (e.g. OpenAI Files API). */
  fileId?: string;
  /** For type `'image'`: hint for image detail level (e.g. OpenAI). */
  detail?: 'auto' | 'low' | 'high';
}

// ---------------------------------------------------------------------------
// Serialized LangChain messages (stored in BullMQ job returnvalue)
// ---------------------------------------------------------------------------

export type SerializedMessageRole = 'system' | 'human' | 'ai' | 'tool';

export interface SerializedMessage {
  role: SerializedMessageRole;
  content: string;
  /** For human messages: optional multimodal attachments (e.g. images). */
  attachments?: PromptAttachment[];
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

export type JobType = 'prompt' | 'command' | 'end-chat';

export const HUMAN_IN_THE_LOOP_TOOL_NAME = 'human_in_the_loop';

/**
 * LLM tool definition for human-in-the-loop. Registered with the model when
 * `humanInTheLoop` is enabled so the agent can pause and request live operator input.
 */
export const HUMAN_INPUT_TOOL_DEFINITION = {
  type: 'function' as const,
  function: {
    name: HUMAN_IN_THE_LOOP_TOOL_NAME,
    description:
      'Ask a human operator for help when you need clarification, are unsure, or the request is outside your goal.',
    parameters: Type.Object({
      question: Type.String({ description: 'The question or prompt to show the operator/user' }),
      context: Type.Optional(Type.String({ description: 'Optional context to help the operator understand (e.g. what you are unsure about)' })),
    }),
  },
};

// ---------------------------------------------------------------------------
// Interrupt types (returned when status is 'interrupted')
// ---------------------------------------------------------------------------

export type InterruptType = 'tool_approval' | 'human_input';

/** One pending action when status is 'interrupted' (tool execution or human_in_the_loop). */
export interface ActionRequest {
  /** Tool call id from the LLM response. */
  id: string;
  /** Tool name (e.g. 'SearchFlights' or 'human_in_the_loop'). */
  name: string;
  /** Tool arguments from the LLM. */
  arguments: Record<string, unknown>;
  /** Human-readable description of what this action does. */
  description: string;
}

export interface Interrupt {
  /** Discriminator: 'tool_approval' for pending tool calls, 'human_input' for operator requests. */
  type: InterruptType;
  actionRequests: ActionRequest[];
  /** Agent id (session is for this agent). */
  agentId?: string;
  /** Goal id (always present in multi-goal mode). */
  goalId?: string;
  /**
   * When interrupting for human_in_the_loop, the AI message with tool_calls is not persisted in
   * history (to avoid orphan tool_calls when concatenating job histories). It is stored here so
   * the next run can prepend it before the ToolMessage when the operator responds.
   */
  pendingMessages?: SerializedMessage[];
}

// ---------------------------------------------------------------------------
// Resume commands (sent via sendCommand to continue after 'interrupted')
// ---------------------------------------------------------------------------

/**
 * Detail for a single tool's approval/rejection. Use when you want to provide
 * feedback on rejection (e.g. "Too expensive, find cheaper options").
 */
export interface ToolApprovalDetail {
  approved: boolean;
  feedback?: string;
}

/**
 * Approve or reject pending tool calls.
 * Keys are tool names; values are `true` (approve), `false` (reject),
 * or a `ToolApprovalDetail` for rejection with feedback.
 *
 * @example
 * { type: 'tool_approval', approved: { SearchFlights: true, BookFlight: false } }
 * { type: 'tool_approval', approved: { BookFlight: { approved: false, feedback: 'Too expensive' } } }
 */
export interface ToolApprovalCommand {
  type: 'tool_approval';
  payload: { approved: Record<string, boolean | ToolApprovalDetail> };
}

/**
 * Respond to a human_in_the_loop request by tipping the agent. The response is
 * passed as the tool result; the agent uses it to formulate its reply.
 *
 * @example
 * { type: 'hitl_response', response: 'The answer is 42' }
 */
export interface HumanResponseCommand {
  type: 'hitl_response';
  payload: { message: string };
}

/**
 * Respond to a human_in_the_loop request by sending a message directly as the agent.
 * No model call is made — this text becomes the agent's reply verbatim.
 *
 * @example
 * { type: 'hitl_direct_reply', message: 'Here is your answer: 42' }
 */
export interface HumanDirectReplyCommand {
  type: 'hitl_direct_reply';
  payload: { message: string };
}

/** Discriminated union for resuming after status 'interrupted'. */
export type ResumeCommand = ToolApprovalCommand | HumanResponseCommand | HumanDirectReplyCommand;

/** Data for orchestrator / single-agent queue jobs (created by the client). */
export interface OrchestratorJobData {
  sessionId: string;
  agentId: string;
  type: JobType;
  prompt?: string;
  /** Optional attachments (e.g. images) for the user message when type === 'prompt'. */
  attachments?: PromptAttachment[];
  /** When type === 'command', the resume payload for human-in-the-loop. */
  command?: ResumeCommand;
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
   * Optional per-request session config. When set, overrides the session config from Redis for this step only.
   */
  sessionConfig?: { autoExecuteTools?: boolean; humanInTheLoop?: boolean };
}

/** Data for per-agent child jobs (created by the orchestrator worker). */
export interface AgentChildJobData {
  sessionId: string;
  /** Required. Worker resolves agent and may use RAG when configured. */
  agentId: string;
  goalId: string;
  prompt?: string;
  /** Optional attachments for the user message (passed from orchestrator job). */
  attachments?: PromptAttachment[];
  /** Carried over when resuming from status 'interrupted' (tool approval). */
  toolCalls?: ToolCall[];
  /** Resume payload when resuming from interrupted. */
  resume?: ResumeCommand;
  /** Tool call id for human_in_the_loop when resuming; content comes from the resume command. */
  humanInputToolCallId?: string;
  /** Pending AI messages to restore when resuming from human_in_the_loop (avoids orphan tool_calls). */
  pendingMessages?: SerializedMessage[];
  /** Optional prefix messages (passed from orchestrator job when present). */
  initialMessages?: SerializedMessage[];
  /** Optional context passed through to tool handlers. */
  context?: Record<string, unknown>;
  /** Optional tool choice (passed from orchestrator job when present). */
  toolChoice?: string | Record<string, unknown> | 'auto' | 'any' | 'none';
  /** From session config: when true, execute tools automatically. */
  autoExecuteTools?: boolean;
  /** From session config: when true, add human_in_the_loop tool to the agent. */
  humanInTheLoop?: boolean;
}

/** Data for add-document jobs (client enqueues; worker processes using rag when RAG-enabled). */
export interface DocumentJobData {
  agentId: string;
  source: DocumentSource;
}

// ---------------------------------------------------------------------------
// Job result types
// ---------------------------------------------------------------------------

/**
 * Unified result type used everywhere: orchestrator steps, agent child jobs,
 * and aggregator output. In single-goal mode this IS the agent result.
 * In multi-goal mode the aggregator populates `childrenValues` with
 * per-agent results.
 *
 * `routing` means the orchestrator dispatched work to agent children
 * and the real result will arrive from the aggregator — clients should
 * ignore this intermediate status.
 */
export interface StepResult {
  /** New messages produced during this step only (delta, not cumulative). */
  history: SerializedMessage[];
  agentId?: string;
  goalId?: string;
  status: 'active' | 'interrupted' | 'ended' | 'routing';
  /** Set when status is 'routing' — the aggregator job ID to follow. */
  routingJobId?: string;
  /** Set when status is 'interrupted': use sendCommand() to approve/reject or reply. */
  interrupts?: Interrupt[];
  /** Per-agent results in multi-goal mode (populated by the aggregator). */
  childrenValues?: Record<string, StepResult>;
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
  /** Fixed list of goals (objectives). Agents can execute any of these goals. */
  goals: AgentGoal[];
  /** When provided (with embedding), RAG is enabled: document queue and retrieve tool for all agents. Omit for workers without RAG. */
  rag?: AgentWorkerRagOptions;
}

/** Options for the client (session + agentId + prompt; addDocument when worker has RAG). */
export interface AgentClientOptions {
  connection: ConnectionOptions;
  /** How long to keep completed/failed result jobs in Redis. */
  jobRetention?: JobRetention;
  /** Optional prefix for queue names. Must match the worker's queuePrefix. */
  queuePrefix?: string;
}

// ---------------------------------------------------------------------------
// Job progress (BullMQ job.updateProgress payload)
// ---------------------------------------------------------------------------

export type JobProgressPhase =
  | 'prompt-read'
  | 'routing'
  | 'thinking'
  | 'typing'
  | 'executing-tool'
  | 'aggregating';

export interface JobProgress {
  phase: JobProgressPhase;
  /** Present when progress is from an orchestrator or agent job (for client filtering). */
  sessionId?: string;
  /** Present when progress is from an agent child job (multi-goal). */
  goalId?: string;
  /** Present when phase is 'executing-tool'. */
  toolName?: string;
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
export const DOCUMENT_QUEUE = 'agent-document';

/** Resolve queue name with optional prefix (default empty for backward compatibility). */
export function getQueueName(prefix: string | undefined, base: string): string {
  return prefix ? `${prefix}/${base}` : base;
}
