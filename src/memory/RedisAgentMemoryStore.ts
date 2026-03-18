import type { Redis } from "ioredis";
import {
  saveMemoryScript,
  getMemoriesScript,
  deleteMemoryScript,
  clearMemoriesScript,
} from "../commands/index.js";
import { DEFAULT_SEARCH_LIMIT, type AgentMemoryStore, type Item } from "./AgentMemoryStore.js";

/** Minimal Redis interface for store operations. Compatible with RedisLike from options.ts. */
export type MemoryRedis = Pick<Redis, "eval">;

/** Build the Redis sorted-set key for a namespace. */
export function buildStoreKey(prefix: string, namespace: string[]): string {
  return `${prefix}:store:${namespace.join(":")}`;
}

/** Build the Redis data key for an individual item. */
export function buildStoreDataKey(prefix: string, namespace: string[], key: string): string {
  return `${prefix}:store:${namespace.join(":")}:${key}`;
}

function serializeItem(item: Item): string {
  return JSON.stringify({
    ...item,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  });
}

function parseItem(raw: string): Item {
  const parsed = JSON.parse(raw);
  return {
    ...parsed,
    createdAt: new Date(parsed.createdAt),
    updatedAt: new Date(parsed.updatedAt),
  };
}

/**
 * Redis-backed implementation of {@link AgentMemoryStore}.
 *
 * Uses a sorted set per namespace (score = updatedAt timestamp) for ordered
 * retrieval and individual string keys for item data. Compound operations
 * are atomic via Lua scripts.
 *
 * Only requires `eval` from the Redis client, so it works with the
 * project's `RedisLike` type.
 */
export class RedisAgentMemoryStore implements AgentMemoryStore {
  constructor(
    private readonly redis: MemoryRedis,
    private readonly prefix: string,
  ) {}

  async put(namespace: string[], key: string, value: Record<string, any>): Promise<void> {
    const setKey = buildStoreKey(this.prefix, namespace);
    const dataKey = buildStoreDataKey(this.prefix, namespace, key);
    const now = new Date();
    const item: Item = { key, value, namespace, createdAt: now, updatedAt: now };
    await this.redis.eval(
      saveMemoryScript,
      2,
      setKey,
      dataKey,
      String(now.getTime()),
      key,
      serializeItem(item),
    );
  }

  async get(namespace: string[], key: string): Promise<Item | null> {
    const dataKey = buildStoreDataKey(this.prefix, namespace, key);
    const raw = (await this.redis.eval(
      "return redis.call('GET', KEYS[1])",
      1,
      dataKey,
    )) as string | null;
    if (!raw) return null;
    return parseItem(raw);
  }

  async search(
    namespacePrefix: string[],
    options?: { filter?: Record<string, any>; limit?: number; offset?: number },
  ): Promise<Item[]> {
    const limit = options?.limit ?? DEFAULT_SEARCH_LIMIT;
    const offset = options?.offset ?? 0;
    const setKey = buildStoreKey(this.prefix, namespacePrefix);
    const dataKeyPrefix = `${setKey}:`;
    const raw = (await this.redis.eval(
      getMemoriesScript,
      1,
      setKey,
      String(limit),
      String(offset),
      dataKeyPrefix,
    )) as (string | null)[];

    const items: Item[] = [];
    for (const s of raw ?? []) {
      if (!s) continue;
      try {
        items.push(parseItem(s));
      } catch {
        // skip malformed entry
      }
    }
    return items;
  }

  async delete(namespace: string[], key: string): Promise<void> {
    const setKey = buildStoreKey(this.prefix, namespace);
    const dataKey = buildStoreDataKey(this.prefix, namespace, key);
    await this.redis.eval(
      deleteMemoryScript,
      2,
      setKey,
      dataKey,
      key,
    );
  }

  /**
   * Clear all items in a namespace. Not part of the base {@link AgentMemoryStore}
   * interface (LangGraph's BaseStore does not have a bulk-clear either).
   */
  async clearNamespace(namespace: string[]): Promise<number> {
    const setKey = buildStoreKey(this.prefix, namespace);
    const dataKeyPrefix = `${setKey}:`;
    return (await this.redis.eval(
      clearMemoriesScript,
      1,
      setKey,
      dataKeyPrefix,
    )) as number;
  }
}
