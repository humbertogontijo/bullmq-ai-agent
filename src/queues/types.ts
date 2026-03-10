import type { StoredMessage } from "@langchain/core/messages";
import type { ModelOptions } from "../options.js";

export interface AgentRunData {
  agentId: string;
  threadId: string;
  /** Subagent name; when set, that subagent runs directly (must match a subagent from BullMQAgentWorker options). */
  subagentId?: string;
  /** Optional run-level metadata (e.g. owner, tenant). Passed to configurable for tools and getAgentConfig. */
  metadata?: Record<string, unknown>;
  input: {
    messages: StoredMessage[];
  };
}

/** Payload when the run was interrupted by the request_human_approval tool. Pass the human's response to resume(). CRM can use this plus run/resume metadata to track conversation owner and handoffs (no explicit owner type in the library). */
export interface HumanInterruptPayload {
  type: "human";
  reason?: string;
  context?: Record<string, unknown>;
}

/** Payload when the run ended via escalate_to_human (full handoff to human). */
export interface EscalationPayload {
  type: "escalate";
  reason?: string;
  context?: Record<string, unknown>;
}

export type InterruptPayload = HumanInterruptPayload | EscalationPayload;

/** Resume payload: human-in-the-loop ({ content }) or escalation ({ reason, context }). */
export type ResumeData = { content: string };

export interface AgentResumeData {
  agentId: string;
  threadId: string;
  result: ResumeData;
  /** When present, select the same runnable (main or subagent) used for the run. */
  subagentId?: string;
  /** Optional run-level metadata. Passed to configurable for tools and getAgentConfig. */
  metadata?: Record<string, unknown>;
}

/** Agent queue job data: payload only; job name is "run" | "resume". */
export type AgentJobData = AgentRunData | AgentResumeData;

export interface AgentJobResult {
  status: "completed" | "interrupted" | "escalated";
  lastMessage?: string;
  interruptPayload?: InterruptPayload;
}

export type DocumentSource = { type: 'url' | 'file' | 'text'; content: string; metadata?: Record<string, unknown> }

/**
 * Ingest queue: document ingestion for RAG.
 */
export interface IngestJobData {
  agentId: string;
  source: DocumentSource;
}
