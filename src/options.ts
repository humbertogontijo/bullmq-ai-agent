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

/** Default queue name values (agent, tools, ingest, aggregator). */
export const QUEUE_NAMES = {
  AGENT: "agent",
  TOOLS: "tools",
  INGEST: "ingest",
  AGGREGATOR: "aggregator",
} as const;

/** Chat or embedding model configuration (provider, model id, api key). Pass apiKey from the caller (e.g. CLI); library does not read process.env. */
export interface ModelOptions {
  provider: string;
  model: string;
  apiKey: string;
}

/** Per-run data passed in graph configurable (threadId/agentId; optional goal and model options). */
export interface RunContext extends Record<string, any> {
  job: Job;
  agentId: string;
  thread_id: string;
  goalId?: string;
  chatModelOptions?: ModelOptions;
  embeddingModelOptions?: ModelOptions;
}
