/**
 * Redis vector store for RAG. Uses node-redis (BullMQ uses ioredis).
 * getVectorStore never creates a connection; caller must pass a ready redis client (e.g. from createRedisClient).
 */

import type { VectorStore } from '@langchain/core/vectorstores';
import { FluentRedisVectorStore, type MetadataFieldSchema } from '@langchain/redis';
import type { ConnectionOptions } from 'bullmq';
import type { RedisClientType } from 'redis';
import { createClient } from 'redis';
import type { EmbeddingConfig } from '../types.js';
import { connectionToRedisUrl } from './connectionToUrl.js';
import { getEmbeddings } from './embeddings.js';

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
): string {
  return queuePrefix ? `${queuePrefix}/agent-knowledge:${agentId}` : `agent-knowledge:${agentId}`;
}

/** Default metadata schema when documents have no metadata. Matches "source" set by loadDocument for url/file; ensures index creation and inference align. */
const DEFAULT_RAG_METADATA_SCHEMA: MetadataFieldSchema[] = [
  { name: 'source', type: 'text' },
];

export interface GetVectorStoreOptions {
  /** Ready-to-use node-redis client. Caller is responsible for creating and closing it. */
  redisClient: RedisClientType;
  queuePrefix: string;
  agentId: string;
  embedding: EmbeddingConfig;
}

/** Create a FluentRedisVectorStore for an agent. Requires a ready redisClient from the caller. */
export async function getVectorStore(
  options: GetVectorStoreOptions,
): Promise<VectorStore> {
  const { redisClient, queuePrefix, agentId, embedding } = options;
  const indexName = getRAGIndexName(queuePrefix, agentId);
  const embeddings = getEmbeddings(embedding);
  const store = new FluentRedisVectorStore(embeddings, {
    redisClient: redisClient as ReturnType<typeof createClient>,
    indexName,
    customSchema:  DEFAULT_RAG_METADATA_SCHEMA,
  });
  return store;
}
