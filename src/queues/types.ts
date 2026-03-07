import type { StoredMessage } from "@langchain/core/messages";
import type { ModelOptions } from "../options.js";

export interface AgentRunData {
  agentId: string;
  threadId: string;
  /** Chat model for the run. API key is passed by the caller (e.g. CLI). */
  chatModelOptions: ModelOptions;
  /** Goal id; when set, the goal's system prompt is used for the model. */
  goalId?: string;
  input: {
    messages: StoredMessage[];
  };
}

/** Payload when the run was interrupted by the request_human_approval tool. Pass the human's response to resume(). */
export interface HumanInterruptPayload {
  type: "human";
  message?: string;
  options?: Record<string, unknown>;
}

/** Payload when the run was interrupted for external tools; client should wait for the aggregator job. */
export interface AggregatorInterruptPayload {
  type: "aggregator";
  aggregatorJobId: string;
}

export type InterruptPayload = HumanInterruptPayload | AggregatorInterruptPayload;

export interface AgentResumeData {
  agentId: string;
  threadId: string;
  result: unknown;
  interruptPayload?: InterruptPayload;
}

/** Agent queue job data: payload only; job name is "run" | "resume". */
export type AgentJobData = AgentRunData | AgentResumeData;

export interface AgentJobResult {
  status: "completed" | "interrupted";
  lastMessage?: string;
  interruptPayload?: InterruptPayload;
}

/**
 * Tools queue: one job per tool invocation.
 */
export interface ToolJobData {
  agentId: string;
  toolName: string;
  args: Record<string, unknown>;
  toolCallId: string;
  threadId: string;
}

/** Tools queue job return value: a StoredMessage of type "tool" (content + tool_call_id). */
export type ToolJobResult = StoredMessage;

/** Stored tool message shape for resume payload. */
export interface StoredToolMessage {
  type: "tool";
  content: string;
  tool_call_id: string;
}

/**
 * Aggregator queue: parent job in a flow. Waits for all tool/subagent children,
 * then adds a single resume job to the agent queue with all results.
 */
export interface AggregatorJobData {
  agentId: string;
  threadId: string;
  chatModelOptions: ModelOptions;
  goalId?: string;
}


export type DocumentSource = { type: 'url' | 'file' | 'text'; content: string; metadata?: Record<string, unknown> }

/**
 * Ingest queue: document ingestion for RAG.
 */
export interface IngestJobData {
  agentId: string;
  source: DocumentSource;
}
