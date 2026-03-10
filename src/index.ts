/**
 * BullMQ-Powered AI Agent (library)
 *
 * Invoke the agent: use BullMQAgentClient (run, resume, ingest).
 * Process jobs: use BullMQAgentWorker (starts agent, tools, subagents, ingest workers).
 *
 * Example CLI: npm run example  (or npx tsx examples/cli.ts)
 */

export { BullMQAgentClient } from "./client.js";
export type {
  IngestDocument,
  IngestOptions,
  JobProgress,
  MessageRole,
  ResumeOptions,
  RunOptions,
  RunResult
} from "./client.js";

export { BullMQAgentWorker } from "./worker.js";
export type { BullMQAgentWorkerOptions } from "./worker.js";

export type { AgentWorkerLogger, ModelOptions, RunContext } from "./options.js";
export { createDefaultAgentWorkerLogger, QUEUE_NAMES } from "./options.js";

export { compileGraph } from "./agent/compile.js";
export type { AgentConfig, Skill } from "./options.js";
export type { Subagent } from "./agent/orchestrator.js";
export { createAgentQueue } from "./queues/agentQueue.js";
export { createIngestQueue } from "./queues/ingestQueue.js";
export type { AgentJobResult, EscalationPayload, HumanInterruptPayload, InterruptPayload, ResumeData } from "./queues/types.js";
export type { ProgressStage, ProgressPayload } from "./agent/progress.js";
export { createProgressMiddleware } from "./agent/progress.js";
export { VectorStoreProvider, type VectorStoreProviderOptions } from "./rag/index.js";
export { RedisVectorStore, type RedisVectorStoreConfig, type RedisAddOptions } from "./redis/RedisVectorStore.js";

