/**
 * BullMQ-Powered AI Agent (library)
 *
 * Invoke the agent: use BullMQAgentClient (run, resume, ingest).
 * Process jobs: use BullMQAgentWorker (starts agent, tools, subagents, ingest workers).
 *
 * Example CLI: npm run example  (or npx tsx examples/cli.ts)
 */

export { BullMQAgentClient, ClientResult, ClientResultError } from "./client.js";
export type {
  BullMQAgentClientOptions,
  ClientResultMeta,
  IngestDocument,
  IngestOptions,
  IngestResult,
  JobProgress,
  MessageRole,
  ResumeOptions,
  ResumeResult,
  ResumeToolOptions,
  RunOptions,
  RunResult,
  SearchKnowledgeOptions,
  SearchResult
} from "./client.js";

export { BullMQAgentWorker } from "./worker.js";
export type { BullMQAgentWorkerOptions } from "./worker.js";

export { createDefaultAgentWorkerLogger, QUEUE_NAMES, runContextContextSchema } from "./options.js";
export type { AgentWorkerLogger, ModelOptions, RunContext } from "./options.js";

export { compileGraph } from "./agent/compile.js";
export type { Subagent } from "./agent/orchestrator.js";
export {
  createHistoryMiddleware,
  DEFAULT_MAX_HISTORY_JOBS,
  getThreadHistoryMessages,
  parseTimestampFromJobId,
  serializeAgentState,
} from "./agent/middlewares/history.js";
export { createProgressMiddleware } from "./agent/middlewares/progress.js";
export type { ProgressPayload, ProgressStage } from "./agent/middlewares/progress.js";
export {
  createSummarizationMiddleware,
  DEFAULT_SUMMARIZE_WHEN_HISTORY_LONGER_THAN,
} from "./agent/middlewares/summarization.js";
export type { SummarizationMiddlewareParams } from "./agent/middlewares/summarization.js";
export type { AgentConfig, Skill } from "./options.js";
export { createAgentQueue } from "./queues/agentQueue.js";
export { createIngestQueue } from "./queues/ingestQueue.js";
export { createSearchQueue } from "./queues/searchQueue.js";
export type { AgentJobResult, StoredAgentState, IngestJobResult, SearchJobResult, StoredMessage } from "./queues/types.js";
export { getLastRequestHumanApprovalToolCall, isResumeRequired } from "./utils/message.js";
export {
  mapChatMessagesToStoredMessages,
  mapStoredMessageToChatMessage,
  mapStoredMessagesToChatMessages,
} from "./utils/messageMapping.js";
export { VectorStoreProvider, type VectorStoreProviderOptions } from "./rag/index.js";
export { RedisVectorStore, type RedisAddOptions, type RedisVectorStoreConfig } from "./redis/RedisVectorStore.js";

// LangChain re-exports for convenience
export { HumanMessage, SystemMessage } from "@langchain/core/messages";
export type { RunnableConfig } from "@langchain/core/runnables";
export { tool } from "@langchain/core/tools";

