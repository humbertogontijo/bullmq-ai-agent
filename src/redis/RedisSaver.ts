/**
 * Redis checkpoint saver using IORedis with optional key prefix.
 * main doc has channel_versions only; channel values live in blob keys
 * (checkpoint_blob:{thread}:{ns}:{channel}:{version}). put() writes blobs only for newVersions (delta).
 * get() reconstructs full state from blobs. Efficient and correct for resume.
 * Requires Redis Stack (JSON + RediSearch modules).
 */
import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  ChannelVersions,
  Checkpoint,
  CheckpointListOptions,
  CheckpointMetadata,
  CheckpointTuple,
  PendingWrite,
} from "@langchain/langgraph-checkpoint";
import {
  BaseCheckpointSaver,
  TASKS,
  copyCheckpoint,
  maxChannelVersion,
  uuid6,
} from "@langchain/langgraph-checkpoint";
import { Cluster, Redis } from 'ioredis';

/** Options for TTL on checkpoint keys. */
export interface TTLConfig {
  /** TTL in minutes. */
  defaultTTL?: number;
  /** Refresh TTL when a checkpoint is read. */
  refreshOnRead?: boolean;
}

/** Escape special characters for RediSearch TAG field queries. */
function escapeRediSearchTagValue(value: string): string {
  if (value === "") return "__EMPTY_STRING__";
  return value
    .replace(/\\/g, "\\\\")
    .replace(/[-\\s,.:<>{}[\]"';!@#$%^&*()+=~|?/]/g, "\\$&");
}

function deterministicStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj))
    return JSON.stringify(obj.map((item) => deterministicStringify(item)));
  const sortedObj: Record<string, unknown> = {};
  const sortedKeys = Object.keys(obj as object).sort();
  for (const key of sortedKeys)
    sortedObj[key] = (obj as Record<string, unknown>)[key];
  return JSON.stringify(sortedObj, (_, value) => {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      const sorted: Record<string, unknown> = {};
      const keys = Object.keys(value).sort();
      for (const k of keys) sorted[k] = (value as Record<string, unknown>)[k];
      return sorted;
    }
    return value;
  });
}

/** Z-set key prefix for pending write keys. */
const WRITE_KEYS_ZSET_PREFIX = "write_keys_zset";

/** Blob key prefix for channel values (one blob per (thread, ns, channel, version)). */
const CHECKPOINT_BLOB_PREFIX = "checkpoint_blob";

const SCHEMAS = [
  {
    index: "checkpoints",
    prefix: "checkpoint:",
    schema: {
      "$.thread_id": { type: "TAG", AS: "thread_id" },
      "$.checkpoint_ns": { type: "TAG", AS: "checkpoint_ns" },
      "$.checkpoint_id": { type: "TAG", AS: "checkpoint_id" },
      "$.parent_checkpoint_id": { type: "TAG", AS: "parent_checkpoint_id" },
      "$.checkpoint_ts": { type: "NUMERIC", AS: "checkpoint_ts" },
      "$.has_writes": { type: "TAG", AS: "has_writes" },
      "$.source": { type: "TAG", AS: "source" },
      "$.step": { type: "NUMERIC", AS: "step" },
    },
  },
  {
    index: "checkpoint_blobs",
    prefix: "checkpoint_blob:",
    schema: {
      "$.thread_id": { type: "TAG", AS: "thread_id" },
      "$.checkpoint_ns": { type: "TAG", AS: "checkpoint_ns" },
      "$.checkpoint_id": { type: "TAG", AS: "checkpoint_id" },
      "$.channel": { type: "TAG", AS: "channel" },
      "$.version": { type: "TAG", AS: "version" },
      "$.type": { type: "TAG", AS: "type" },
    },
  },
  {
    index: "checkpoint_writes",
    prefix: "checkpoint_write:",
    schema: {
      "$.thread_id": { type: "TAG", AS: "thread_id" },
      "$.checkpoint_ns": { type: "TAG", AS: "checkpoint_ns" },
      "$.checkpoint_id": { type: "TAG", AS: "checkpoint_id" },
      "$.task_id": { type: "TAG", AS: "task_id" },
      "$.idx": { type: "NUMERIC", AS: "idx" },
      "$.channel": { type: "TAG", AS: "channel" },
      "$.type": { type: "TAG", AS: "type" },
    },
  },
] as const;

/** Parses FT.SEARCH raw reply into documents with .value (parsed JSON). */
function parseFtSearchReply(reply: unknown): { value: Record<string, unknown> }[] {
  const arr = Array.isArray(reply) ? reply : [];
  if (arr.length < 1) return [];
  const documents: { value: Record<string, unknown> }[] = [];
  for (let i = 1; i < arr.length; i += 2) {
    const key = arr[i];
    const fields = arr[i + 1];
    if (!Array.isArray(fields)) continue;
    for (let j = 0; j < fields.length; j += 2) {
      if (fields[j] === "$") {
        const raw = fields[j + 1];
        try {
          const value =
            typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, unknown>);
          documents.push({ value });
        } catch {
          // skip malformed
        }
        break;
      }
    }
  }
  return documents;
}

export interface RedisSaverOptions {
  /** IORedis client (Redis or Cluster). Must support JSON and RediSearch commands. */
  client: Redis | Cluster;
  /** Optional TTL and refresh settings. */
  ttlConfig?: TTLConfig;
  /** Optional prefix for all keys (e.g. "agent:"). Enables multiple tenants in one Redis. */
  prefix?: string;
}

/**
 * Checkpoint saver backed by Redis (via IORedis) with optional key prefix.
 * Requires Redis Stack (JSON and RediSearch modules).
 */
export class RedisSaver extends BaseCheckpointSaver {
  private readonly client: Redis | Cluster;
  private readonly ttlConfig?: TTLConfig;
  private readonly prefix: string;

  constructor(options: RedisSaverOptions) {
    super();
    const { client, ttlConfig, prefix = "" } = options;
    this.client = client;
    this.ttlConfig = ttlConfig;
    this.prefix = prefix.endsWith(":") || prefix === "" ? prefix : `${prefix}:`;
  }

  /** Build a full key with prefix. */
  private k(parts: string): string {
    return `${this.prefix}${parts}`;
  }

  /** Index name for RediSearch; includes prefix so different prefixes use different indexes. */
  private indexName(base: string): string {
    return this.prefix ? `${this.prefix.replace(/:$/, "")}${base}` : base;
  }

  /** Prefix string used in FT.CREATE for this saver's keys. */
  private indexPrefix(schemaPrefix: string): string {
    return `${this.prefix}${schemaPrefix}`;
  }

  static async fromUrl(
    url: string,
    options?: { ttlConfig?: TTLConfig; prefix?: string }
  ): Promise<RedisSaver> {
    const client = new Redis(url);
    const saver = new RedisSaver({
      client,
      ttlConfig: options?.ttlConfig,
      prefix: options?.prefix,
    });
    await saver.ensureIndexes();
    return saver;
  }

  async get(config: RunnableConfig): Promise<Checkpoint | undefined> {
    return (await this.getTuple(config))?.checkpoint;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns ?? "";
    const checkpointId = config.configurable?.checkpoint_id;
    if (!threadId) return undefined;

    let key: string;
    let jsonDoc: Record<string, unknown> | null;

    if (checkpointId) {
      key = this.k(`checkpoint:${threadId}:${checkpointNs}:${checkpointId}`);
      jsonDoc = await this.jsonGet(key);
    } else {
      const pattern = this.k(`checkpoint:${threadId}:${checkpointNs}:*`);
      const keys = await this.client.keys(pattern);
      if (keys.length === 0) return undefined;
      keys.sort();
      key = keys[keys.length - 1];
      jsonDoc = await this.jsonGet(key);
    }

    if (!jsonDoc) return undefined;
    if (
      this.ttlConfig?.refreshOnRead &&
      this.ttlConfig?.defaultTTL
    )
      await this.applyTTL(key);
    const { checkpoint, pendingWrites } =
      await this.loadCheckpointWithWrites(jsonDoc);
    return await this.createCheckpointTuple(jsonDoc, checkpoint, pendingWrites);
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions
  ): Promise<RunnableConfig> {
    await this.ensureIndexes();
    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns ?? "";
    const parentCheckpointId = config.configurable?.checkpoint_id;
    if (!threadId) throw new Error("thread_id is required");

    const checkpointId = checkpoint.id ?? uuid6(0);
    const key = this.k(
      `checkpoint:${threadId}:${checkpointNs}:${checkpointId}`
    );
    // store checkpoint without channel_values; store channel blobs by (thread, ns, channel, version).
    // Only write blobs for newVersions (efficient). On load we reconstruct full state from channel_versions + blobs.
    const storedCheckpoint = copyCheckpoint(checkpoint);
    const channelValues = storedCheckpoint.channel_values ?? {};
    const stored = storedCheckpoint as unknown as Record<string, unknown>;
    delete stored.channel_values;

    for (const channel of Object.keys(newVersions)) {
      const version = String(
        (storedCheckpoint.channel_versions ?? {})[channel] ?? newVersions[channel]
      );
      const value = channel in channelValues ? channelValues[channel] : null;
      const [type, serialized] = await this.serde.dumpsTyped(value ?? undefined);
      const blobKey = this.k(
        `${CHECKPOINT_BLOB_PREFIX}:${threadId}:${checkpointNs === "" ? "__empty__" : checkpointNs}:${channel}:${version}`
      );
      const blobDoc: Record<string, unknown> = {
        t: type,
        b: Buffer.from(serialized).toString("base64"),
      };
      await this.jsonSet(blobKey, blobDoc);
      if (this.ttlConfig?.defaultTTL) await this.applyTTL(blobKey);
    }

    const zsetKey = this.k(
      `${WRITE_KEYS_ZSET_PREFIX}:${threadId}:${checkpointNs}:${checkpointId}`
    );
    const writesExist = (await this.client.exists(zsetKey)) > 0;

    // Store checkpoint and metadata as objects.
    // Native JSON.stringify in jsonSet() calls toJSON() on LangChain messages.
    // Native JSON.stringify in jsonSet() will call toJSON() on LangChain messages, preserving
    // the lc/id form so serde.loadsTyped on read revives them correctly.
    const jsonDoc = {
      thread_id: threadId,
      checkpoint_ns: checkpointNs === "" ? "__empty__" : checkpointNs,
      checkpoint_id: checkpointId,
      parent_checkpoint_id: parentCheckpointId ?? null,
      checkpoint: storedCheckpoint,
      metadata,
      checkpoint_ts: Date.now(),
      has_writes: writesExist ? "true" : "false",
    };
    this.addSearchableMetadataFields(
      jsonDoc as Record<string, unknown>,
      metadata
    );
    await this.jsonSet(key, jsonDoc);
    if (this.ttlConfig?.defaultTTL) await this.applyTTL(key);
    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpointId,
      },
    };
  }

  async *list(
    config: RunnableConfig | null,
    options?: CheckpointListOptions & { filter?: CheckpointMetadata }
  ): AsyncGenerator<CheckpointTuple> {
    await this.ensureIndexes();
    if (options?.filter !== undefined) {
      const hasNullFilter = Object.values(options.filter).some((v) => v === null);
      const queryParts: string[] = [];
      if (config?.configurable?.thread_id) {
        const threadId = config.configurable.thread_id.replace(
          /[-.@]/g,
          "\\$&"
        );
        queryParts.push(`(@thread_id:{${threadId}})`);
      }
      if (config?.configurable?.checkpoint_ns !== undefined) {
        const checkpointNs = config.configurable.checkpoint_ns;
        if (checkpointNs === "")
          queryParts.push(`(@checkpoint_ns:{__empty__})`);
        else {
          const escapedNs = checkpointNs.replace(/[-.@]/g, "\\$&");
          queryParts.push(`(@checkpoint_ns:{${escapedNs}})`);
        }
      }
      if (!options?.before && options?.filter) {
        for (const [key, value] of Object.entries(options.filter)) {
          if (value === undefined || value === null) continue;
          if (typeof value === "string") {
            const escapedKey = escapeRediSearchTagValue(key);
            const escapedValue = escapeRediSearchTagValue(value);
            queryParts.push(`(@${escapedKey}:{${escapedValue}})`);
          } else if (typeof value === "number") {
            const escapedKey = escapeRediSearchTagValue(key);
            queryParts.push(`(@${escapedKey}:[${value} ${value}])`);
          }
        }
      }
      if (queryParts.length === 0) queryParts.push("*");
      const query = queryParts.join(" ");
      const limit = options?.limit ?? 10;
      const fetchLimit =
        options?.before && !config?.configurable?.thread_id
          ? 1000
          : options?.before
            ? limit * 10
            : limit;

      try {
        const indexName = this.indexName("checkpoints");
        const reply = await this.client.call(
          "FT.SEARCH",
          indexName,
          query,
          "LIMIT",
          0,
          fetchLimit,
          "SORTBY",
          "checkpoint_ts",
          "DESC"
        );
        const documents = parseFtSearchReply(reply);
        let yieldedCount = 0;
        for (const doc of documents) {
          if (yieldedCount >= limit) break;
          if (options?.before?.configurable?.checkpoint_id) {
            if (
              (doc.value.checkpoint_id as string) >=
              options.before.configurable.checkpoint_id
            )
              continue;
          }
          const jsonDoc = doc.value;
          let matches = true;
          if (
            (hasNullFilter || options?.before) &&
            options?.filter
          ) {
            for (const [filterKey, filterValue] of Object.entries(
              options.filter
            )) {
              const metadataValue = (jsonDoc.metadata as Record<string, unknown>)?.[filterKey];
              if (filterValue === null) {
                if (metadataValue !== null) {
                  matches = false;
                  break;
                }
              } else if (filterValue !== undefined) {
                if (
                  typeof filterValue === "object" &&
                  filterValue !== null
                ) {
                  if (
                    deterministicStringify(metadataValue) !==
                    deterministicStringify(filterValue)
                  ) {
                    matches = false;
                    break;
                  }
                } else if (metadataValue !== filterValue) {
                  matches = false;
                  break;
                }
              }
            }
            if (!matches) continue;
          }
          const { checkpoint, pendingWrites } =
            await this.loadCheckpointWithWrites(jsonDoc);
          yield await this.createCheckpointTuple(
            jsonDoc,
            checkpoint,
            pendingWrites
          );
          yieldedCount++;
        }
        return;
      } catch (error) {
        const msg = (error as Error)?.message ?? "";
        if (!msg.includes("no such index")) throw error;
      }

      if (config?.configurable?.thread_id) {
        const threadId = config.configurable.thread_id;
        const checkpointNs = config.configurable.checkpoint_ns ?? "";
        const pattern = this.k(
          `checkpoint:${threadId}:${checkpointNs}:*`
        );
        const keys = await this.client.keys(pattern);
        keys.sort().reverse();
        let filteredKeys = keys;
        if (options?.before?.configurable?.checkpoint_id) {
          const beforeKey = this.k(
            `checkpoint:${options.before.configurable.thread_id ?? threadId}:${options.before.configurable.checkpoint_ns ?? checkpointNs}:${options.before.configurable.checkpoint_id}`
          );
          const beforeIndex = keys.indexOf(beforeKey);
          if (beforeIndex > 0) filteredKeys = keys.slice(beforeIndex + 1);
          else if (beforeIndex === 0) filteredKeys = [];
        }
        const limit = options?.limit ?? 10;
        const limitedKeys = filteredKeys.slice(0, limit);
        for (const key of limitedKeys) {
          const jsonDoc = await this.jsonGet(key);
          if (!jsonDoc) continue;
          let matches = true;
          for (const [filterKey, filterValue] of Object.entries(
            options.filter ?? {}
          )) {
            const metadataValue = (jsonDoc.metadata as Record<string, unknown>)?.[filterKey];
            if (filterValue === null) {
              if (metadataValue !== null) {
                matches = false;
                break;
              }
            } else if (metadataValue !== filterValue) {
              matches = false;
              break;
            }
          }
          if (!matches) continue;
          const { checkpoint, pendingWrites } =
            await this.loadCheckpointWithWrites(jsonDoc);
          yield await this.createCheckpointTuple(
            jsonDoc,
            checkpoint,
            pendingWrites
          );
        }
      } else {
        const globalPattern =
          config?.configurable?.checkpoint_ns !== undefined
            ? this.k(
                `checkpoint:*:${config.configurable.checkpoint_ns === "" ? "__empty__" : config.configurable.checkpoint_ns}:*`
              )
            : this.k("checkpoint:*");
        const allKeys = await this.client.keys(globalPattern);
        const allDocuments: { key: string; doc: Record<string, unknown> }[] = [];
        for (const key of allKeys) {
          const jsonDoc = await this.jsonGet(key);
          if (jsonDoc) allDocuments.push({ key, doc: jsonDoc });
        }
        allDocuments.sort(
          (a, b) =>
            (b.doc.checkpoint_ts as number) - (a.doc.checkpoint_ts as number)
        );
        let yieldedCount = 0;
        const limit = options?.limit ?? 10;
        for (const { doc: jsonDoc } of allDocuments) {
          if (yieldedCount >= limit) break;
          if (options?.before?.configurable?.checkpoint_id) {
            if (
              (jsonDoc.checkpoint_id as string) >=
              options.before.configurable.checkpoint_id
            )
              continue;
          }
          let matches = true;
          if (options?.filter) {
            for (const [filterKey, filterValue] of Object.entries(
              options.filter
            )) {
              const metadataValue = (jsonDoc.metadata as Record<string, unknown>)?.[filterKey];
              if (filterValue === null) {
                if (metadataValue !== null) {
                  matches = false;
                  break;
                }
              } else if (filterValue !== undefined) {
                if (
                  typeof filterValue === "object" &&
                  filterValue !== null
                ) {
                  if (
                    deterministicStringify(metadataValue) !==
                    deterministicStringify(filterValue)
                  ) {
                    matches = false;
                    break;
                  }
                } else if (metadataValue !== filterValue) {
                  matches = false;
                  break;
                }
              }
            }
            if (!matches) continue;
          }
          const { checkpoint, pendingWrites } =
            await this.loadCheckpointWithWrites(jsonDoc);
          yield await this.createCheckpointTuple(
            jsonDoc,
            checkpoint,
            pendingWrites
          );
          yieldedCount++;
        }
      }
      return;
    }

    const searchOptions: CheckpointListOptions & { filter?: CheckpointMetadata } = {
      ...options,
      filter: {} as CheckpointMetadata,
    };
    yield* this.list(config, searchOptions);
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void> {
    await this.ensureIndexes();
    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns ?? "";
    const checkpointId = config.configurable?.checkpoint_id;
    if (!threadId || !checkpointId)
      throw new Error("thread_id and checkpoint_id are required");

    const writeKeys: string[] = [];
    const baseTimestamp = performance.now() * 1e3;
    for (let idx = 0; idx < writes.length; idx++) {
      const [channel, value] = writes[idx];
      const writeKey = this.k(
        `checkpoint_write:${threadId}:${checkpointNs}:${checkpointId}:${taskId}:${idx}`
      );
      writeKeys.push(writeKey);
      const writeDoc = {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpointId,
        task_id: taskId,
        idx,
        channel,
        type: typeof value === "object" ? "json" : "string",
        value,
        timestamp: baseTimestamp,
        global_idx: baseTimestamp + idx,
      };
      await this.jsonSet(writeKey, writeDoc);
    }
    if (writeKeys.length > 0) {
      const zsetKey = this.k(
        `${WRITE_KEYS_ZSET_PREFIX}:${threadId}:${checkpointNs}:${checkpointId}`
      );
      const zaddArgs: (string | number)[] = [];
      writeKeys.forEach((key, idx) => {
        zaddArgs.push(baseTimestamp + idx, key);
      });
      await this.client.call("ZADD", zsetKey, ...zaddArgs);
      if (this.ttlConfig?.defaultTTL)
        await this.applyTTL(...writeKeys, zsetKey);
    }
    const checkpointKey = this.k(
      `checkpoint:${threadId}:${checkpointNs}:${checkpointId}`
    );
    const exists = await this.client.exists(checkpointKey);
    if (exists) {
      const currentDoc = await this.jsonGet(checkpointKey);
      if (currentDoc) {
        currentDoc.has_writes = "true";
        await this.jsonSet(checkpointKey, currentDoc);
      }
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    const checkpointPattern = this.k(`checkpoint:${threadId}:*`);
    const checkpointKeys = await this.client.keys(checkpointPattern);
    if (checkpointKeys.length > 0) await this.client.del(...checkpointKeys);
    const blobPattern = this.k(`${CHECKPOINT_BLOB_PREFIX}:${threadId}:*`);
    const blobKeys = await this.client.keys(blobPattern);
    if (blobKeys.length > 0) await this.client.del(...blobKeys);
    const writeKeysPattern = this.k(`checkpoint_write:${threadId}:*`);
    const writeKeys = await this.client.keys(writeKeysPattern);
    if (writeKeys.length > 0) await this.client.del(...writeKeys);
    const zsetPattern = this.k(`${WRITE_KEYS_ZSET_PREFIX}:${threadId}:*`);
    const zsetKeys = await this.client.keys(zsetPattern);
    if (zsetKeys.length > 0) await this.client.del(...zsetKeys);
  }

  async end(): Promise<void> {
    await this.client.quit();
  }

  private async jsonGet(key: string): Promise<Record<string, unknown> | null> {
    const raw = await this.client.call("JSON.GET", key, "$");
    if (raw == null) return null;
    try {
      const parsed =
        typeof raw === "string" ? JSON.parse(raw) : raw;
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      return arr[0] ?? null;
    } catch {
      return null;
    }
  }

  private async jsonSet(
    key: string,
    doc: Record<string, unknown>
  ): Promise<void> {
    await this.client.call("JSON.SET", key, "$", JSON.stringify(doc));
  }

  private async loadPendingWrites(
    threadId: string,
    checkpointNs: string,
    checkpointId: string
  ): Promise<[string, string, unknown][] | undefined> {
    const pattern = this.k(
      `checkpoint_write:${threadId}:${checkpointNs}:${checkpointId}:*`
    );
    const writeKeys = await this.client.keys(pattern);
    if (writeKeys.length === 0) return undefined;
    const writeDocuments: Record<string, unknown>[] = [];
    for (const writeKey of writeKeys) {
      const writeDoc = await this.jsonGet(writeKey);
      if (writeDoc) writeDocuments.push(writeDoc);
    }
    writeDocuments.sort(
      (a, b) => (a.global_idx as number) - (b.global_idx as number)
    );
    const pendingWrites: [string, string, unknown][] = [];
    for (const writeDoc of writeDocuments) {
      const deserializedValue = await this.serde.loadsTyped(
        "json",
        JSON.stringify(writeDoc.value)
      );
      pendingWrites.push([
        writeDoc.task_id as string,
        writeDoc.channel as string,
        deserializedValue,
      ]);
    }
    return pendingWrites;
  }

  private async loadCheckpointWithWrites(jsonDoc: Record<string, unknown>): Promise<{
    checkpoint: Checkpoint;
    pendingWrites?: [string, string, unknown][];
  }> {
    const rawCheckpoint = jsonDoc.checkpoint as Record<string, unknown>;
    const checkpoint = await this.serde.loadsTyped(
      "json",
      JSON.stringify(rawCheckpoint)
    );
    // Reconstruct channel_values from blobs (one per channel_versions entry).
    if (checkpoint.channel_versions) {
      const threadId = jsonDoc.thread_id as string;
      const ns =
        jsonDoc.checkpoint_ns === "__empty__" ? "" : (jsonDoc.checkpoint_ns as string);
      const nsKey = ns === "" ? "__empty__" : ns;
      checkpoint.channel_values = {};
      for (const [channel, version] of Object.entries(checkpoint.channel_versions)) {
        const blobKey = this.k(
          `${CHECKPOINT_BLOB_PREFIX}:${threadId}:${nsKey}:${channel}:${version}`
        );
        const blobDoc = await this.jsonGet(blobKey);
        if (blobDoc && typeof blobDoc.t === "string" && typeof blobDoc.b === "string") {
          const bytes = new Uint8Array(Buffer.from(blobDoc.b as string, "base64"));
          const value = await this.serde.loadsTyped(blobDoc.t as string, bytes);
          if (value !== undefined && value !== null) {
            (checkpoint.channel_values as Record<string, unknown>)[channel] = value;
          }
        }
      }
    }
    if (
      checkpoint.v < 4 &&
      jsonDoc.parent_checkpoint_id != null
    ) {
      const actualNs =
        jsonDoc.checkpoint_ns === "__empty__" ? "" : (jsonDoc.checkpoint_ns as string);
      await this.migratePendingSends(
        checkpoint,
        jsonDoc.thread_id as string,
        actualNs,
        jsonDoc.parent_checkpoint_id as string
      );
    }
    let pendingWrites: [string, string, unknown][] | undefined;
    if (jsonDoc.has_writes === "true") {
      const actualNs =
        jsonDoc.checkpoint_ns === "__empty__" ? "" : (jsonDoc.checkpoint_ns as string);
      pendingWrites = await this.loadPendingWrites(
        jsonDoc.thread_id as string,
        actualNs,
        jsonDoc.checkpoint_id as string
      );
    }
    return { checkpoint, pendingWrites };
  }

  private async migratePendingSends(
    checkpoint: Checkpoint,
    threadId: string,
    checkpointNs: string,
    parentCheckpointId: string
  ): Promise<void> {
    const parentWrites = await this.loadPendingWrites(
      threadId,
      checkpointNs,
      parentCheckpointId
    );
    if (!parentWrites || parentWrites.length === 0) return;
    const taskWrites = parentWrites.filter(([, channel]) => channel === TASKS);
    if (taskWrites.length === 0) return;
    const allTasks = taskWrites.map(([, , value]) => value);
    checkpoint.channel_values ??= {};
    checkpoint.channel_values[TASKS] = allTasks;
    checkpoint.channel_versions[TASKS] =
      Object.keys(checkpoint.channel_versions).length > 0
        ? maxChannelVersion(...Object.values(checkpoint.channel_versions))
        : 1;
  }

  private async createCheckpointTuple(
    jsonDoc: Record<string, unknown>,
    checkpoint: Checkpoint,
    pendingWrites?: [string, string, unknown][]
  ): Promise<CheckpointTuple> {
    const checkpointNs =
      jsonDoc.checkpoint_ns === "__empty__" ? "" : (jsonDoc.checkpoint_ns as string);
    const metadata = await this.serde.loadsTyped(
      "json",
      JSON.stringify(jsonDoc.metadata)
    );
    return {
      config: {
        configurable: {
          thread_id: jsonDoc.thread_id as string,
          checkpoint_ns: checkpointNs,
          checkpoint_id: jsonDoc.checkpoint_id as string,
        },
      },
      checkpoint,
      metadata,
      parentConfig: jsonDoc.parent_checkpoint_id
        ? {
            configurable: {
              thread_id: jsonDoc.thread_id as string,
              checkpoint_ns: checkpointNs,
              checkpoint_id: jsonDoc.parent_checkpoint_id as string,
            },
          }
        : undefined,
      pendingWrites,
    };
  }

  private addSearchableMetadataFields(
    jsonDoc: Record<string, unknown>,
    metadata: CheckpointMetadata
  ): void {
    if (!metadata) return;
    if ("source" in metadata) jsonDoc.source = metadata.source;
    if ("step" in metadata) jsonDoc.step = metadata.step;
    if ("writes" in metadata)
      jsonDoc.writes =
        typeof metadata.writes === "object"
          ? JSON.stringify(metadata.writes)
          : metadata.writes;
    if ("score" in metadata) jsonDoc.score = metadata.score;
  }

  private async applyTTL(...keys: string[]): Promise<void> {
    if (!this.ttlConfig?.defaultTTL) return;
    const ttlSeconds = Math.floor(this.ttlConfig.defaultTTL * 60);
    const results = await Promise.allSettled(
      keys.map((key) => this.client.expire(key, ttlSeconds))
    );
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "rejected")
        console.warn(
          `Failed to set TTL for key ${keys[i]}:`,
          (results[i] as PromiseRejectedResult).reason
        );
    }
  }

  private async ensureIndexes(): Promise<void> {
    for (const schema of SCHEMAS) {
      try {
        const indexName = this.indexName(schema.index);
        const prefixWithColon = this.indexPrefix(schema.prefix);
        const args: (string | number)[] = [
          indexName,
          "ON",
          "JSON",
          "PREFIX",
          "1",
          prefixWithColon,
          "SCHEMA",
        ];
        for (const [path, spec] of Object.entries(schema.schema)) {
          args.push(path, "AS", spec.AS, spec.type);
        }
        await this.client.call("FT.CREATE", ...args);
      } catch (error) {
        const msg = (error as Error)?.message ?? "";
        if (!/index\s+already\s+exists/i.test(msg))
          console.error(
            `Failed to create index ${schema.index}:`,
            msg
          );
      }
    }
  }
}
