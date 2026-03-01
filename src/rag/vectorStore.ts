/**
 * Redis vector store for RAG. Uses node-redis (BullMQ uses ioredis).
 * getVectorStore never creates a connection; caller must pass a ready redis client (e.g. from createRedisClient).
 */

import type { ConnectionOptions } from 'bullmq';
import { createClient } from 'redis';
import type { RedisClientType } from 'redis';
import { FluentRedisVectorStore } from '@langchain/redis';
import type { VectorStore } from '@langchain/core/vectorstores';
import { connectionToRedisUrl } from './connectionToUrl.js';
import { getEmbeddings } from './embeddings.js';
import type { EmbeddingConfig } from '../types.js';

/** Create and connect a node-redis client from BullMQ connection options. Caller must call .quit() when done. */
export async function createRedisClient(
  connection: ConnectionOptions,
): Promise<RedisClientType> {
  const url = connectionToRedisUrl(connection);
  const client = createClient({ url });
  await client.connect();
  return client as RedisClientType;
}

export function getRAGIndexName(
  queuePrefix: string,
  agentId: string,
  override?: string,
): string {
  return override ?? `rag:${queuePrefix}:agent:${agentId}`;
}

export interface GetVectorStoreOptions {
  /** Ready-to-use node-redis client. Caller is responsible for creating and closing it. */
  redisClient: RedisClientType;
  queuePrefix: string;
  agentId: string;
  embedding: EmbeddingConfig;
  indexName?: string;
}

/** Create a FluentRedisVectorStore for an agent. Requires a ready redisClient from the caller. */
export async function getVectorStore(
  options: GetVectorStoreOptions,
): Promise<VectorStore> {
  const { redisClient, queuePrefix, agentId, embedding, indexName: override } = options;
  const indexName = getRAGIndexName(queuePrefix, agentId, override);
  const embeddings = getEmbeddings(embedding);
  const store = new FluentRedisVectorStore(embeddings, {
    redisClient: redisClient as ReturnType<typeof createClient>,
    indexName,
  });
  return store;
}
