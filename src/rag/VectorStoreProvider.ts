import { VectorStore } from "@langchain/core/vectorstores";
import { MetadataFieldSchema } from "@langchain/redis";
import { Cluster, Redis } from 'ioredis';
import type { ModelOptions } from "../options.js";
import { RedisVectorStore } from "../redis/RedisVectorStore.js";
import { getEmbeddings } from "./embeddings.js";

export interface VectorStoreProviderOptions {
  client: Redis | Cluster;
  prefix?: string;
}

const DEFAULT_RAG_METADATA_SCHEMA: MetadataFieldSchema[] = [
  { name: "source", type: "text" },
];

/**
 * Provides RedisVectorStore instances (ioredis-backed) keyed by index name (e.g. agentId).
 * Caller passes embeddingModelOptions (including apiKey); library does not read process.env.
 */
export class VectorStoreProvider {
  readonly client: Redis | Cluster;
  readonly prefix: string | undefined;

  constructor(options: VectorStoreProviderOptions) {
    this.client = options.client;
    this.prefix = options.prefix;
  }

  /** Create a RedisVectorStore for an agent. embeddingModelOptions (with apiKey) must be passed by the caller (e.g. CLI). */
  async getVectorStore(
    indexName: string,
    embeddingModelOptions: ModelOptions,
    inferredSchema?: MetadataFieldSchema[]
  ): Promise<VectorStore> {
    const embeddings = getEmbeddings({
      provider: embeddingModelOptions.provider as "openai" | "cohere",
      model: embeddingModelOptions.model,
      apiKey: embeddingModelOptions.apiKey,
    });
    const store = new RedisVectorStore(embeddings, {
      client: this.client,
      indexName,
      customSchema: inferredSchema ?? DEFAULT_RAG_METADATA_SCHEMA,
      keyPrefix: this.prefix,
    });
    return store;
  }
}
