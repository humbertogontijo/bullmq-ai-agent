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
  AgentResumeToolFlowChild,
  AgentRunFlowChild,
  BullMQAgentClientOptions,
  ClientResultMeta,
  IngestDocument,
  IngestOptions,
  IngestResult,
  JobProgress,
  MessageRole,
  ResumeResult,
  ResumeToolFlowChildOptions,
  ResumeToolOptions,
  RunFlowChildOptions,
  RunOptions,
  RunResult,
  SearchKnowledgeOptions,
  SearchResult,
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
  DEFAULT_SUMMARIZATION_THRESHOLD,
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
export { VectorStoreProvider } from "./rag/index.js";
export type {
  GetVectorStoreOptions,
  VectorStoreProviderInterface,
  VectorStoreProviderOptions,
} from "./rag/index.js";
export { RedisVectorStore, type RedisAddOptions, type RedisVectorStoreConfig } from "./redis/RedisVectorStore.js";

export type { AgentMemoryStore, Item } from "./memory/index.js";
export {
  DEFAULT_SEARCH_LIMIT,
  MEMORY_NAMESPACE_PREFIX,
  buildMemoryNamespace,
  buildContactMemoryNamespace,
  RedisAgentMemoryStore,
  buildStoreKey,
  buildStoreDataKey,
} from "./memory/index.js";
export type { MemoryRedis } from "./memory/index.js";
export {
  createAgentMemoryMiddleware,
} from "./agent/middlewares/agentMemory.js";
export type { AgentMemoryMiddlewareParams } from "./agent/middlewares/agentMemory.js";

// LangChain re-exports for convenience
export { HumanMessage, SystemMessage } from "@langchain/core/messages";
export type { RunnableConfig } from "@langchain/core/runnables";
export { tool } from "@langchain/core/tools";

