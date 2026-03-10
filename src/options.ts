import type { SystemMessageFields } from "@langchain/core/messages";
import { Job } from "bullmq";

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

/** Skill for progressive disclosure: description in system prompt, content loaded on-demand via load_skill tool. */
export interface Skill {
  name: string;
  description: string;
  content: string | (() => Promise<string>);
}

/** Per-run data passed in graph configurable (threadId/agentId; optional subagent, model options, metadata from run/resume). */
export interface RunContext extends Record<string, any> {
  job: Job;
  agentId: string;
  thread_id: string;
  subagentId?: string;
  chatModelOptions?: ModelOptions;
  embeddingModelOptions?: ModelOptions;
  /** Optional metadata from run/resume job data. CRM can pass owner, tenant, etc.; tools and getAgentConfig can read it. */
  metadata?: Record<string, unknown>;
}
