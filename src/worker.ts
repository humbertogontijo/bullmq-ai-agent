/**
 * Single entry point to start and stop all BullMQ agent workers.
 * Pass connection + optional queue prefix via options; CLI/examples can fill from env.
 * Thread history is built from job return values; no RedisSaver/checkpointer by default.
 */
import type { StructuredToolInterface } from "@langchain/core/tools";
import { type SystemMessageFields } from "@langchain/core/messages";
import { isRedisInstance, RedisConnection, type ConnectionOptions, type QueueOptions } from "bullmq";
import type { Cluster, Redis } from "ioredis";
import { compileGraph } from "./agent/compile.js";
import type { Subagent } from "./agent/orchestrator.js";
import { escalateToHuman } from "./agent/tools/escalateToHuman.js";
import { requestHumanInTheLoop } from "./agent/tools/humanInTheLoop.js";
import { createSaveMemoryTool, createDeleteMemoryTool } from "./agent/tools/memory.js";
import { AgentConfig, createDefaultAgentWorkerLogger, type AgentWorkerLogger, type GetTodosCallback, type ModelOptions } from "./options.js";
import type { AgentMemoryMiddlewareParams } from "./agent/middlewares/agentMemory.js";
import type { SummarizationMiddlewareParams } from "./agent/middlewares/summarization.js";
import type { AgentMemoryStore } from "./memory/AgentMemoryStore.js";
import { RedisAgentMemoryStore } from "./memory/RedisAgentMemoryStore.js";
import type { VectorStoreProviderInterface } from "./rag/index.js";
import { VectorStoreProvider } from "./rag/index.js";
import { getQueueKeyPrefix } from "./queues/queueKeys.js";
import { AgentWorker } from "./workers/agentWorker.js";
import { IngestWorker } from "./workers/ingestWorker.js";
import { SearchWorker } from "./workers/searchWorker.js";

/**
 * Options for BullMQAgentWorker.
 *
 * **Required:** `connection`, `chatModelOptions`, `embeddingModelOptions` (from QueueOptions and below).
 * **Optional:** all others. Valid combinations: you can omit subagents and use only getAgentConfig for
 * per-agent prompts; or provide subagents with or without getAgentConfig.
 * Wrong config (e.g. subagentId at run time that does not match a subagent name) fails at first job.
 */
export interface BullMQAgentWorkerOptions extends QueueOptions {
  /** Redis connection (required by QueueOptions). Same Redis and prefix as client. */
  connection: ConnectionOptions;
  /** Redis connection for RAG/document vector store only. If omitted, uses connection (queues use connection). Ignored when vectorStoreProvider is set. */
  documentConnection?: ConnectionOptions;
  /** Custom vector store provider (e.g. PostgresVectorStore or any class extending VectorStore). When set, used for RAG/search/ingest instead of the built-in Redis provider; documentConnection is not used for RAG. */
  vectorStoreProvider?: VectorStoreProviderInterface;
  /** Default chat model (provider, model, apiKey). Used when getAgentConfig does not provide a model for the agent. */
  chatModelOptions: ModelOptions;
  /** Subagents; when run/resume sets subagentId, that subagent runs directly. Supports customer-support flows: replying, suggestions (use ephemeral: true), takeovers via request_human_approval and escalate_to_human; run/resume metadata is passed to configurable for CRM-owned state. */
  subagents?: Subagent[];
  /** System prompt for the main agent when there is no subagentId in the request. */
  systemPrompt?: SystemMessageFields;
  /** Async function returning per-agent config (systemPrompt, default model/temperature). Merged with worker chatModelOptions. */
  getAgentConfig?: (agentId: string) => Promise<AgentConfig | undefined>;
  /** Embedding model for RAG/search and ingest (provider, model, apiKey). When provided together with vectorStoreProvider (or documentConnection), enables the retrieve tool and ingest/search workers. */
  embeddingModelOptions?: ModelOptions;
  /** Logger passed to all workers. When provided, used for error/fail events; debug used for completed if available. */
  logger?: AgentWorkerLogger;
  /** When set, passed to getPreviousReturnvalues Lua as max number of previous jobs to load (limits history size). */
  maxHistoryMessages?: number;
  /** Optional custom tools to add to the main agent (merged with built-in tools: retrieve, request_human_approval, escalate_to_human). Use for CRM-specific or domain tools. */
  tools?: StructuredToolInterface[];
  /** Custom AgentMemoryStore implementation. When provided, takes precedence over the built-in RedisAgentMemoryStore (enableAgentMemory must still be truthy to wire tools and middleware). */
  agentMemoryStore?: AgentMemoryStore;
  /** Enable cross-thread agent memory (persisted by agentId). When true, adds save_memory/delete_memory tools and memory middleware with a built-in RedisAgentMemoryStore. Pass an object to configure maxMemories. */
  enableAgentMemory?: boolean | AgentMemoryMiddlewareParams;
  /** Enable history summarization when thread exceeds threshold. When true, uses default options; pass an object to configure historyThreshold. */
  enableSummarization?: boolean | SummarizationMiddlewareParams;
  /**
   * Callback that returns initial required todos for the agent before each run.
   * Receives the job context (agentId, threadId, contactId, metadata) so todos can be
   * tailored per agent or per thread. The TodoPersistenceMiddleware merges these with
   * persisted todos from the previous job's return value, adding any missing ones.
   */
  getTodos?: GetTodosCallback;
}

/**
 * Starts all workers (agent, ingest) and provides a single close() to stop them.
 */
export class BullMQAgentWorker {
  private readonly connection: ConnectionOptions;
  private readonly documentConnection: ConnectionOptions | undefined;
  private vectorStoreProvider: VectorStoreProviderInterface | undefined;
  private readonly options: Omit<QueueOptions, "connection">;
  private readonly chatModelOptions: ModelOptions;
  private readonly subagents: Subagent[] | undefined;
  private readonly systemPrompt?: SystemMessageFields;
  private readonly getAgentConfig?: (agentId: string) => Promise<AgentConfig | undefined>;
  private readonly embeddingModelOptions: ModelOptions | undefined;

  private readonly logger: AgentWorkerLogger;
  private readonly maxHistoryMessages: number | undefined;
  private readonly customTools: StructuredToolInterface[] | undefined;
  private readonly agentMemory: AgentMemoryMiddlewareParams | undefined;
  private readonly customAgentMemoryStore: AgentMemoryStore | undefined;
  private readonly summarization: SummarizationMiddlewareParams | undefined;
  private readonly getTodos: GetTodosCallback | undefined;

  private agentWorker: AgentWorker | null = null;
  private ingestWorker: IngestWorker | null = null;
  private searchWorker: SearchWorker | null = null;
  private redisConnection: RedisConnection | null = null;
  private documentRedisConnection: RedisConnection | null = null;

  constructor(options: BullMQAgentWorkerOptions) {
    const { documentConnection, connection, chatModelOptions, subagents, systemPrompt, getAgentConfig, embeddingModelOptions, logger, maxHistoryMessages, tools: customTools, enableAgentMemory, agentMemoryStore, enableSummarization, vectorStoreProvider, getTodos, ...bullOptions } = options;
    this.connection = connection;
    this.documentConnection = documentConnection;
    this.vectorStoreProvider = vectorStoreProvider;
    this.chatModelOptions = chatModelOptions;
    this.subagents = subagents;
    this.systemPrompt = systemPrompt;
    this.getAgentConfig = getAgentConfig;
    this.embeddingModelOptions = embeddingModelOptions;
    this.logger = logger ?? createDefaultAgentWorkerLogger();
    this.maxHistoryMessages = maxHistoryMessages;
    this.customTools = customTools;
    this.agentMemory = enableAgentMemory
      ? (typeof enableAgentMemory === "object" ? enableAgentMemory : {})
      : undefined;
    this.customAgentMemoryStore = agentMemoryStore;
    this.summarization = enableSummarization
      ? (typeof enableSummarization === "object" ? enableSummarization : {})
      : undefined;
    this.getTodos = getTodos;
    this.options = bullOptions;
  }

  async start(): Promise<void> {
    let queueClient: Redis | Cluster;
    let queueOptions: QueueOptions;
    if (isRedisInstance(this.connection)) {
      queueClient = this.connection;
      queueOptions = { ...this.options, connection: queueClient };
    } else {
      this.redisConnection = new RedisConnection(this.connection);
      queueClient = await this.redisConnection.client;
      queueOptions = { ...this.options, connection: await this.redisConnection.client };
    }

    if (!this.vectorStoreProvider && this.embeddingModelOptions) {
      const docConnection = this.documentConnection ?? this.connection;
      let documentClient: Redis | Cluster;
      if (docConnection === this.connection) {
        documentClient = queueClient;
      } else if (isRedisInstance(docConnection)) {
        documentClient = docConnection;
      } else {
        this.documentRedisConnection = new RedisConnection(docConnection);
        documentClient = await this.documentRedisConnection.client;
      }
      this.vectorStoreProvider = new VectorStoreProvider({
        client: documentClient,
        prefix: this.options.prefix,
      });
    }
    const ragEnabled = this.vectorStoreProvider != null && this.embeddingModelOptions != null;

    const baseTools = [
      requestHumanInTheLoop,
      escalateToHuman,
      ...(this.agentMemory ? [createSaveMemoryTool(), createDeleteMemoryTool()] : []),
      ...(this.customTools ?? []),
    ];

    const compiledGraph = await compileGraph({
      tools: baseTools,
      subagents: this.subagents,
      systemPrompt: this.systemPrompt,
      getAgentConfig: this.getAgentConfig,
      agentMemory: this.agentMemory,
      summarization: this.summarization,
      rag: ragEnabled && this.vectorStoreProvider ? { vectorStoreProvider: this.vectorStoreProvider } : undefined,
    });

    const redis = queueClient as Redis;
    const queueKeyPrefix = getQueueKeyPrefix(this.options.prefix);

    const memoryStore = this.agentMemory
      ? (this.customAgentMemoryStore ?? new RedisAgentMemoryStore(redis, queueKeyPrefix))
      : undefined;

    this.agentWorker = new AgentWorker(
      {
        compiledGraph,
        redis,
        queueKeyPrefix,
        chatModelOptions: this.chatModelOptions,
        embeddingModelOptions: this.embeddingModelOptions,
        logger: this.logger,
        maxHistoryMessages: this.maxHistoryMessages,
        agentMemoryStore: memoryStore,
        getTodos: this.getTodos,
      },
      queueOptions
    );
    this.agentWorker.start();

    if (ragEnabled && this.embeddingModelOptions) {
      this.ingestWorker = new IngestWorker(
        { vectorStoreProvider: this.vectorStoreProvider!, embeddingModelOptions: this.embeddingModelOptions, logger: this.logger },
        queueOptions
      );
      this.ingestWorker.start();

      this.searchWorker = new SearchWorker(
        { vectorStoreProvider: this.vectorStoreProvider!, embeddingModelOptions: this.embeddingModelOptions, logger: this.logger },
        queueOptions
      );
      this.searchWorker.start();
    }
  }

  /**
   * Gracefully close all workers and Redis connections.
   */
  async close(): Promise<void> {
    await Promise.all([this.agentWorker?.close(), this.ingestWorker?.close(), this.searchWorker?.close()]);
    if (this.documentRedisConnection) {
      const client = await this.documentRedisConnection.client;
      await client.quit();
      this.documentRedisConnection = null;
    }
    if (this.redisConnection) {
      const client = await this.redisConnection.client;
      await client.quit();
      this.redisConnection = null;
    }
    this.agentWorker = null;
    this.ingestWorker = null;
    this.searchWorker = null;
  }
}
