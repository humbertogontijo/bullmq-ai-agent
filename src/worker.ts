/**
 * Single entry point to start and stop all BullMQ agent workers.
 * Pass connection + optional queue prefix via options; CLI/examples can fill from env.
 */
import type { SystemMessageFields } from "@langchain/core/messages";
import {
  FlowProducer,
  RedisConnection,
  isRedisInstance,
  type ConnectionOptions,
  type QueueOptions,
} from "bullmq";
import type { Cluster, Redis } from "ioredis";
import { compileGraph } from "./agent/compile.js";
import type { Goal } from "./agent/orchestrator.js";
import { requestHumanInTheLoop } from "./agent/tools/humanInTheLoop.js";
import { createSearchKnowledgeTool } from "./agent/tools/searchKnowledge.js";
import { createDefaultAgentWorkerLogger, type AgentWorkerLogger, type ModelOptions } from "./options.js";
import { createToolsQueue } from "./queues/toolsQueue.js";
import { VectorStoreProvider } from "./rag/index.js";
import { RedisSaver } from "./redis/RedisSaver.js";
import { AgentWorker } from "./workers/agentWorker.js";
import { AggregatorWorker } from "./workers/aggregatorWorker.js";
import { IngestWorker } from "./workers/ingestWorker.js";
import { ResumeWorker } from "./workers/resumeWorker.js";
import { ToolsWorker } from "./workers/toolsWorker.js";

export interface BullMQAgentWorkerOptions extends QueueOptions {
  /** Redis connection for RAG/document vector store only. If omitted, uses connection (queues/checkpointer use connection). */
  documentConnection?: ConnectionOptions;
  /** Goals: id + systemPrompt; when a run/resume sets goal to an id, that goal's systemPrompt is used for the model. */
  goals?: Goal[];
  /** Async function returning system prompt for an agent. Order: goal systemPrompt (if set), then this, then messages. */
  agentSystemPrompt?: (agentId: string) => Promise<SystemMessageFields[]>;
  /** Embedding model for RAG/search and ingest (provider, model, apiKey). Pass apiKey from the caller (e.g. CLI). */
  embeddingModelOptions: ModelOptions;
  /** Logger passed to all workers. When provided, used for error/fail events; debug used for completed if available. */
  logger?: AgentWorkerLogger;
}

/**
 * Starts all workers (agent, tools, subagents, ingest) and provides a single close() to stop them.
 * Queues, checkpointer, and workers use `connection`. VectorStoreProvider uses `documentConnection` with `connection` as fallback.
 */
export class BullMQAgentWorker {
  private readonly connection: ConnectionOptions;
  private readonly documentConnection: ConnectionOptions | undefined;
  private vectorStoreProvider!: VectorStoreProvider;
  private checkpointer!: RedisSaver;
  private readonly options: Omit<QueueOptions, "connection">;
  private readonly goals: Goal[] | undefined;
  private readonly agentSystemPrompt?: (agentId: string) => Promise<SystemMessageFields[]>;
  private readonly embeddingModelOptions: ModelOptions;

  private readonly logger: AgentWorkerLogger;

  private agentWorker: AgentWorker | null = null;
  private aggregatorWorker: AggregatorWorker | null = null;
  private toolsWorker: ToolsWorker | null = null;
  private ingestWorker: IngestWorker | null = null;
  private flowProducer: FlowProducer | null = null;
  private redisConnection: RedisConnection | null = null;
  private documentRedisConnection: RedisConnection | null = null;

  constructor(options: BullMQAgentWorkerOptions) {
    const { documentConnection, connection, goals, agentSystemPrompt, embeddingModelOptions, logger, ...bullOptions } = options;
    this.connection = connection;
    this.documentConnection = documentConnection;
    this.goals = goals;
    this.agentSystemPrompt = agentSystemPrompt;
    this.embeddingModelOptions = embeddingModelOptions;
    this.logger = logger ?? createDefaultAgentWorkerLogger();
    this.options = bullOptions;
  }

  async start(): Promise<void> {
    // Queues and checkpointer: use connection only
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

    // VectorStoreProvider: use documentConnection with connection as fallback
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
    });

    this.checkpointer = new RedisSaver({
      client: queueClient,
      ttlConfig: {
        defaultTTL: 60 * 24,
        refreshOnRead: true,
      },
      prefix: this.options.prefix,
    });
    const toolsQueue = createToolsQueue(queueOptions);
    this.flowProducer = new FlowProducer(queueOptions);

    const baseTools = [createSearchKnowledgeTool(this.vectorStoreProvider), requestHumanInTheLoop];
    const goals = this.goals;
    const goalTools = goals?.flatMap((g) => g.tools ?? []) ?? [];
    const tools = [...baseTools, ...goalTools];
    const agentSystemPrompt = this.agentSystemPrompt;

    const compiledGraph = await compileGraph({
      tools: baseTools,
      toolsQueue,
      flowProducer: this.flowProducer,
      checkpointer: this.checkpointer,
      goals,
      agentSystemPrompt,
    });

    const resumeWorker = new ResumeWorker({ compiledGraph });
    resumeWorker.start();

    this.agentWorker = new AgentWorker(
      {
        compiledGraph,
        resumeWorker,
        embeddingModelOptions: this.embeddingModelOptions,
        logger: this.logger,
      },
      queueOptions
    );
    this.agentWorker.start();

    this.aggregatorWorker = new AggregatorWorker(
      { resumeWorker, embeddingModelOptions: this.embeddingModelOptions, logger: this.logger },
      queueOptions
    );
    this.aggregatorWorker.start();

    this.toolsWorker = new ToolsWorker(
      { tools, goals, embeddingModelOptions: this.embeddingModelOptions, logger: this.logger },
      queueOptions
    );
    this.toolsWorker.start();

    this.ingestWorker = new IngestWorker(
      { vectorStoreProvider: this.vectorStoreProvider, embeddingModelOptions: this.embeddingModelOptions, logger: this.logger },
      queueOptions
    );
    this.ingestWorker.start();
  }

  /**
   * Gracefully close all workers, the flow producer, and Redis connections.
   */
  async close(): Promise<void> {
    await Promise.all([
      this.agentWorker?.close(),
      this.aggregatorWorker?.close(),
      this.toolsWorker?.close(),
      this.ingestWorker?.close(),
    ]);
    if (this.flowProducer) {
      await this.flowProducer.close();
      this.flowProducer = null;
    }
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
    this.aggregatorWorker = null;
    this.toolsWorker = null;
    this.ingestWorker = null;
  }
}
