/**
 * Single entry point to start and stop all BullMQ agent workers.
 * Pass connection + optional queue prefix via options; CLI/examples can fill from env.
 */
import { type SystemMessageFields } from "@langchain/core/messages";
import { isRedisInstance, RedisConnection, type ConnectionOptions, type QueueOptions } from "bullmq";
import type { Cluster, Redis } from "ioredis";
import { compileGraph } from "./agent/compile.js";
import type { Subagent } from "./agent/orchestrator.js";
import { escalateToHuman } from "./agent/tools/escalateToHuman.js";
import { requestHumanInTheLoop } from "./agent/tools/humanInTheLoop.js";
import { createLoadSkillTool } from "./agent/tools/loadSkill.js";
import { createSearchKnowledgeTool } from "./agent/tools/searchKnowledge.js";
import { AgentConfig, createDefaultAgentWorkerLogger, type AgentWorkerLogger, type ModelOptions, type Skill } from "./options.js";
import { VectorStoreProvider } from "./rag/index.js";
import { RedisSaver } from "./redis/RedisSaver.js";
import { AgentWorker } from "./workers/agentWorker.js";
import { IngestWorker } from "./workers/ingestWorker.js";
import { ResumeWorker } from "./workers/resumeWorker.js";
import { SearchWorker } from "./workers/searchWorker.js";

export interface BullMQAgentWorkerOptions extends QueueOptions {
  /** Redis connection for RAG/document vector store only. If omitted, uses connection (queues/checkpointer use connection). */
  documentConnection?: ConnectionOptions;
  /** Default chat model (provider, model, apiKey). Used when getAgentConfig does not provide a model for the agent. */
  chatModelOptions: ModelOptions;
  /** Subagents; when run/resume sets subagentId, that subagent runs directly. Supports customer-support flows: replying, suggestions (use ephemeral: true), takeovers via request_human_approval and escalate_to_human; run/resume metadata is passed to configurable for CRM-owned state. */
  subagents?: Subagent[];
  /** System prompt for the main agent when there is no subagentId in the request. */
  systemPrompt?: SystemMessageFields;
  /** Async function returning per-agent config (systemPrompt, default model/temperature). Merged with worker chatModelOptions. */
  getAgentConfig?: (agentId: string) => Promise<AgentConfig | undefined>;
  /** Optional skills for progressive disclosure; descriptions go in system prompt, load_skill loads full content. */
  skills?: Skill[];
  /** Embedding model for RAG/search and ingest (provider, model, apiKey). Pass apiKey from the caller (e.g. CLI). */
  embeddingModelOptions: ModelOptions;
  /** Logger passed to all workers. When provided, used for error/fail events; debug used for completed if available. */
  logger?: AgentWorkerLogger;
}

/**
 * Starts all workers (agent, ingest) and provides a single close() to stop them.
 */
export class BullMQAgentWorker {
  private readonly connection: ConnectionOptions;
  private readonly documentConnection: ConnectionOptions | undefined;
  private vectorStoreProvider!: VectorStoreProvider;
  private checkpointer!: RedisSaver;
  private readonly options: Omit<QueueOptions, "connection">;
  private readonly chatModelOptions: ModelOptions;
  private readonly subagents: Subagent[] | undefined;
  private readonly systemPrompt?: SystemMessageFields;
  private readonly getAgentConfig?: (agentId: string) => Promise<AgentConfig | undefined>;
  private readonly skills: Skill[] | undefined;
  private readonly embeddingModelOptions: ModelOptions;

  private readonly logger: AgentWorkerLogger;

  private agentWorker: AgentWorker | null = null;
  private ingestWorker: IngestWorker | null = null;
  private searchWorker: SearchWorker | null = null;
  private redisConnection: RedisConnection | null = null;
  private documentRedisConnection: RedisConnection | null = null;

  constructor(options: BullMQAgentWorkerOptions) {
    const { documentConnection, connection, chatModelOptions, subagents, systemPrompt, getAgentConfig, skills, embeddingModelOptions, logger, ...bullOptions } = options;
    this.connection = connection;
    this.documentConnection = documentConnection;
    this.chatModelOptions = chatModelOptions;
    this.subagents = subagents;
    this.systemPrompt = systemPrompt;
    this.getAgentConfig = getAgentConfig;
    this.skills = skills;
    this.embeddingModelOptions = embeddingModelOptions;
    this.logger = logger ?? createDefaultAgentWorkerLogger();
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

    const baseTools = [
      createSearchKnowledgeTool(this.vectorStoreProvider),
      requestHumanInTheLoop,
      escalateToHuman,
      ...(this.skills?.length ? [createLoadSkillTool(this.skills)] : []),
    ];
    const systemPrompt = this.systemPrompt;
    const getAgentConfig = this.getAgentConfig;
    const skills = this.skills;

    const compiledGraph = await compileGraph({
      tools: baseTools,
      checkpointer: this.checkpointer,
      subagents: this.subagents,
      systemPrompt,
      getAgentConfig,
      skills,
    });

    const resumeWorker = new ResumeWorker({ compiledGraph });
    resumeWorker.start();

    this.agentWorker = new AgentWorker(
      {
        compiledGraph,
        resumeWorker,
        chatModelOptions: this.chatModelOptions,
        embeddingModelOptions: this.embeddingModelOptions,
        logger: this.logger,
      },
      queueOptions
    );
    this.agentWorker.start();

    this.ingestWorker = new IngestWorker(
      { vectorStoreProvider: this.vectorStoreProvider, embeddingModelOptions: this.embeddingModelOptions, logger: this.logger },
      queueOptions
    );
    this.ingestWorker.start();

    this.searchWorker = new SearchWorker(
      { vectorStoreProvider: this.vectorStoreProvider, embeddingModelOptions: this.embeddingModelOptions, logger: this.logger },
      queueOptions
    );
    this.searchWorker.start();
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
