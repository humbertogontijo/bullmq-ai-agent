import type { AIMessageFields, HumanMessageFields, RemoveMessageFields, SystemMessageFields, ToolMessageFields } from "@langchain/core/messages";
import { AgentState } from "../agent/state.js";

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  /** When status is "completed", the actual result or answer (e.g. the client's full name value). Use empty string when there is no concrete result to store. */
  fulfillment: string;
}

export interface StoredToolMessage {
  type: "tool";
  data: ToolMessageFields;
}

export interface StoredHumanMessage {
  type: "human";
  data: HumanMessageFields;
}

/** Stored form of an AI message (serializable). */
export interface StoredAIMessage {
  type: "ai";
  data: AIMessageFields;
}

export interface StoredRemoveMessage {
  type: "remove";
  data: RemoveMessageFields;
}

export interface StoredSystemMessage {
  type: "system";
  data: SystemMessageFields;
}

export type StoredMessage = StoredToolMessage | StoredHumanMessage | StoredAIMessage | StoredRemoveMessage | StoredSystemMessage

export interface AgentRunData {
  agentId: string;
  threadId: string;
  /** Contact id (end-user identity). Scopes per-contact memories so personal data never leaks across users. Defaults to threadId when omitted. */
  contactId?: string;
  /** Subagent name; when set, that subagent runs directly (must match a subagent from BullMQAgentWorker options). */
  subagentId?: string;
  /** Optional run-level metadata (e.g. owner, tenant). Passed to configurable for tools and getAgentConfig. */
  metadata?: Record<string, unknown>;
  input: {
    messages: StoredMessage[];
  };
}

/** Agent queue job data for resumeTool: worker builds tool message from last job's AI tool_call_id. */
export interface AgentResumeToolData {
  agentId: string;
  threadId: string;
  /** Contact id (end-user identity). Scopes per-contact memories so personal data never leaks across users. Defaults to threadId when omitted. */
  contactId?: string;
  /** Human response content for the request_human_approval tool. */
  content: string;
  /** Pass when resuming so the same runnable (main or subagent) is used. */
  subagentId?: string;
  /** Optional run-level metadata. */
  metadata?: Record<string, unknown>;
}

/** Agent queue job data (run or resumeTool). Discriminator is job name: "run" | "resumeTool". */
export type AgentJobData = AgentRunData | AgentResumeToolData;

/** One stream state chunk (serializable). When the graph interrupts (e.g. human-in-the-loop), the worker returns the serialized state (messages only); the client detects resume by checking if the last message is an AI message with tool_calls. */
export interface StoredAgentState extends Omit<AgentState, 'messages' | '__interrupt__'> {
  messages: StoredMessage[];
}

/** Job return value: final stream state (messages) and optional interrupt tool payload. */
export type AgentJobResult = StoredAgentState;

export type DocumentSource = { type: 'url' | 'file' | 'text'; content: string; metadata?: Record<string, unknown> }

/**
 * Ingest queue: document ingestion for RAG.
 */
export interface IngestJobData {
  agentId: string;
  source: DocumentSource;
}

/** Result of an ingest job (worker return value). */
export interface IngestJobResult {
  /** Number of source documents ingested. */
  documents: number;
  /** Number of chunks (split documents) added to the vector store. */
  chunks: number;
}

/**
 * Search queue: similarity search over the RAG vector store for an agent.
 */
export interface SearchJobData {
  agentId: string;
  query: string;
  /** Number of results to return (default 5). */
  k?: number;
}

/** Result of a search job (worker return value). */
export interface SearchJobResult {
  results: Array<{ content: string; metadata: Record<string, unknown> }>;
  count: number;
}
