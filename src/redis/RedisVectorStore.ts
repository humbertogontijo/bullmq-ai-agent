/**
 * Redis vector store using ioredis (replacement for @langchain/redis FluentRedisVectorStore).
 * Uses RediSearch for vector similarity search with optional metadata schema and FilterExpression.
 */
import { Document } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { VectorStore } from "@langchain/core/vectorstores";
import type { FilterExpression } from "@langchain/redis";
import {
  checkForSchemaMismatch,
  deserializeMetadataField,
  inferMetadataSchema,
  serializeMetadataField,
  type MetadataFieldSchema,
} from "@langchain/redis";
import { Cluster, Redis } from 'ioredis';
import { v4 } from "uuid";

/** RediSearch schema field type names for FT.CREATE (no node-redis dependency). */
const RS = {
  TEXT: "TEXT",
  TAG: "TAG",
  NUMERIC: "NUMERIC",
  GEO: "GEO",
  VECTOR: "VECTOR",
} as const;

export interface RedisVectorStoreConfig {
  /** ioredis client (Redis or Cluster). Must support RediSearch (FT.*). */
  client: Redis | Cluster;
  indexName: string;
  /** Vector index algorithm: FLAT or HNSW. Default HNSW. */
  indexOptions?: {
    ALGORITHM?: "FLAT" | "HNSW";
    DISTANCE_METRIC?: "L2" | "IP" | "COSINE";
    BLOCK_SIZE?: number;
    M?: number;
    EF_CONSTRUCTION?: number;
    EF_RUNTIME?: number;
  };
  createIndexOptions?: {
    ON?: "HASH" | "JSON";
    PREFIX?: string;
    LANGUAGE?: string;
    [key: string]: string | number | undefined;
  };
  keyPrefix?: string;
  contentKey?: string;
  metadataKey?: string;
  vectorKey?: string;
  filter?: FilterExpression;
  ttl?: number;
  customSchema?: MetadataFieldSchema[];
}

export interface RedisAddOptions {
  keys?: string[];
  batchSize?: number;
}

/**
 * Build FT.CREATE SCHEMA arguments for ioredis.call("FT.CREATE", ...).
 * Converts our config + MetadataFieldSchema[] into the flat arg list after SCHEMA.
 */
function buildFtCreateSchemaArgs(
  vectorKey: string,
  contentKey: string,
  dimensions: number,
  indexOptions: NonNullable<RedisVectorStoreConfig["indexOptions"]>,
  customSchema: MetadataFieldSchema[]
): (string | number)[] {
  const args: (string | number)[] = [];

  const algo = indexOptions.ALGORITHM ?? "HNSW";
  const dist = indexOptions.DISTANCE_METRIC ?? "COSINE";

  // Vector field: VECTOR FLAT|HNSW <num> DIM n DISTANCE_METRIC ... TYPE FLOAT32 [options]
  const vecNum = algo === "FLAT" ? 6 : 6;
  args.push(vectorKey, RS.VECTOR, algo, vecNum, "DIM", dimensions, "DISTANCE_METRIC", dist, "TYPE", "FLOAT32");
  if (algo === "FLAT" && indexOptions.BLOCK_SIZE != null) {
    args.push("BLOCK_SIZE", indexOptions.BLOCK_SIZE);
  }
  if (algo === "HNSW") {
    if (indexOptions.M != null) args.push("M", indexOptions.M);
    if (indexOptions.EF_CONSTRUCTION != null) args.push("EF_CONSTRUCTION", indexOptions.EF_CONSTRUCTION);
    if (indexOptions.EF_RUNTIME != null) args.push("EF_RUNTIME", indexOptions.EF_RUNTIME);
  }

  args.push(contentKey, RS.TEXT);

  for (const field of customSchema) {
    args.push(field.name);
    switch (field.type) {
      case "tag": {
        args.push(RS.TAG);
        if (field.options?.separator) args.push("SEPARATOR", field.options.separator);
        if (field.options?.caseSensitive) args.push("CASESENSITIVE");
        if (field.options?.noindex) args.push("NOINDEX");
        break;
      }
      case "text": {
        args.push(RS.TEXT);
        if (field.options?.weight != null) args.push("WEIGHT", field.options.weight);
        if (field.options?.noStem) args.push("NOSTEM");
        if (field.options?.noindex) args.push("NOINDEX");
        if (field.options?.sortable) args.push("SORTABLE");
        break;
      }
      case "numeric": {
        args.push(RS.NUMERIC);
        if (field.options?.sortable) args.push("SORTABLE");
        if (field.options?.noindex) args.push("NOINDEX");
        break;
      }
      case "geo": {
        args.push(RS.GEO);
        if (field.options?.noindex) args.push("NOINDEX");
        break;
      }
      default:
        args.push(RS.TEXT);
    }
  }

  return args;
}

/**
 * Redis vector store backed by ioredis and RediSearch.
 * API-compatible with LangChain VectorStore (addDocuments, similaritySearch, similaritySearchVectorWithScore).
 */
export class RedisVectorStore extends VectorStore {
  FilterType: FilterExpression | string = "*";
  private readonly client: Redis | Cluster;
  readonly indexName: string;
  readonly indexOptions: NonNullable<RedisVectorStoreConfig["indexOptions"]>;
  readonly createIndexOptions: { ON?: string; PREFIX?: string; [key: string]: string | number | undefined };
  readonly keyPrefix: string;
  readonly contentKey: string;
  readonly metadataKey: string;
  readonly vectorKey: string;
  readonly filter?: FilterExpression;
  readonly ttl?: number;
  readonly customSchema?: MetadataFieldSchema[];

  constructor(embeddings: EmbeddingsInterface, config: RedisVectorStoreConfig) {
    super(embeddings, config);
    this.client = config.client;
    this.indexName = config.indexName;
    this.indexOptions = config.indexOptions ?? {
      ALGORITHM: "HNSW",
      DISTANCE_METRIC: "COSINE",
    };
    this.keyPrefix = config.keyPrefix ?? `doc:${config.indexName}:`;
    this.contentKey = config.contentKey ?? "content";
    this.metadataKey = config.metadataKey ?? "metadata";
    this.vectorKey = config.vectorKey ?? "content_vector";
    this.filter = config.filter;
    this.FilterType = config.filter ?? "*";
    this.ttl = config.ttl;
    this.customSchema = config.customSchema;
    this.createIndexOptions = {
      ON: "HASH",
      PREFIX: this.keyPrefix,
      ...config.createIndexOptions,
    };
  }

  _vectorstoreType(): string {
    return "redis_ioredis";
  }

  async addDocuments(documents: Document[], options?: RedisAddOptions): Promise<void> {
    const texts = documents.map((d) => d.pageContent);
    const vectors = await this.embeddings.embedDocuments(texts);
    return this.addVectors(vectors, documents, options);
  }

  async addVectors(
    vectors: number[][],
    documents: Document[],
    options: RedisAddOptions = {}
  ): Promise<void> {
    const { keys, batchSize = 1000 } = options;
    if (!vectors.length || !vectors[0].length) throw new Error("No vectors provided");
    await this.createIndex(documents, vectors[0].length);

    for (let i = 0; i < vectors.length; i += batchSize) {
      const batch = vectors.slice(i, i + batchSize);
      const docsBatch = documents.slice(i, i + batchSize);
      const multi = this.client.multi();
      for (let j = 0; j < batch.length; j++) {
        const idx = i + j;
        const key = keys && keys[idx] ? keys[idx] : `${this.keyPrefix}${v4()}`;
        const doc = docsBatch[j];
        const metadata = (doc?.metadata as Record<string, unknown>) ?? {};
        const hash: Record<string, string | Buffer> = {
          [this.vectorKey]: this.getFloat32Buffer(batch[j]),
          [this.contentKey]: doc.pageContent,
        };
        if (this.customSchema?.length) {
          for (const fieldSchema of this.customSchema) {
            const v = metadata[fieldSchema.name];
            if (v !== undefined && v !== null) {
              hash[fieldSchema.name] = serializeMetadataField(fieldSchema, v) as string;
            }
          }
        }
        multi.hset(key, hash);
        if (this.ttl) multi.expire(key, this.ttl);
      }
      await multi.exec();
    }
  }

  async similaritySearchVectorWithScore(
    query: number[],
    k: number,
    filter?: FilterExpression
  ): Promise<[Document, number][]> {
    if (filter && this.filter) {
      throw new Error("cannot provide both `filter` and `this.filter`");
    }
    const expr = filter ?? this.filter;
    const [baseQuery, opts] = this.buildQuery(query, k, expr);

    const args = [
      "FT.SEARCH",
      this.indexName,
      baseQuery,
      "PARAMS",
      2,
      "vector",
      opts.PARAMS.vector as Buffer,
      "RETURN",
      opts.RETURN.length,
      ...opts.RETURN,
      "SORTBY",
      opts.SORTBY,
      "DIALECT",
      opts.DIALECT,
      "LIMIT",
      opts.LIMIT.from,
      opts.LIMIT.size,
    ] as const;

    const reply = await this.client.call(...args) as unknown[];
    const total = reply[0] as number;
    const results: [Document, number][] = [];

    if (total > 0 && Array.isArray(reply)) {
      for (let i = 1; i < reply.length; i++) {
        const keyOrDoc = reply[i];
        const valueList = reply[i + 1];
        i++;
        if (typeof keyOrDoc !== "string" || !Array.isArray(valueList)) continue;
        const document: Record<string, string> = {};
        for (let j = 0; j < valueList.length; j += 2) {
          const field = valueList[j] as string;
          const val = valueList[j + 1];
          document[field] = typeof val === "string" ? val : (val instanceof Buffer ? val.toString("utf8") : String(val));
        }
        const vectorScore = document.vector_score;
        if (vectorScore != null) {
          const metadata: Record<string, unknown> = {};
          if (this.customSchema?.length) {
            for (const fieldSchema of this.customSchema) {
              const raw = document[fieldSchema.name];
              if (raw !== undefined && raw !== null) {
                metadata[fieldSchema.name] = deserializeMetadataField(fieldSchema, raw);
              }
            }
          }
          results.push([
            new Document({
              pageContent: document[this.contentKey] ?? "",
              metadata,
            }),
            Number(vectorScore),
          ]);
        }
      }
    }

    return results;
  }

  private buildQuery(
    query: number[],
    k: number,
    filter?: FilterExpression
  ): [string, { PARAMS: { vector: Buffer }; RETURN: string[]; SORTBY: string; DIALECT: number; LIMIT: { from: number; size: number } }] {
    const vectorScoreField = "vector_score";
    const hybridFields = filter
      ? this.prepareFilter(filter)
      : "*";
    const baseQuery = `${hybridFields} => [KNN ${k} @${this.vectorKey} $vector AS ${vectorScoreField}]`;
    const returnFields = [this.contentKey, vectorScoreField];
    if (this.customSchema) {
      for (const f of this.customSchema) returnFields.push(f.name);
    }
    return [
      baseQuery,
      {
        PARAMS: { vector: this.getFloat32Buffer(query) },
        RETURN: returnFields,
        SORTBY: vectorScoreField,
        DIALECT: 2,
        LIMIT: { from: 0, size: k },
      },
    ];
  }

  private prepareFilter(filter?: FilterExpression): string {
    if (!filter) return "*";
    if (typeof filter === "object" && "toString" in filter && typeof filter.toString === "function") {
      return filter.toString();
    }
    throw new Error(
      "RedisVectorStore only supports FilterExpression filters. Use Tag(), Num(), Text(), Geo(), or Timestamp() from @langchain/redis. For simple string[] or string filters, use a different store."
    );
  }

  async checkIndexState(): Promise<"default" | "legacy" | "none"> {
    try {
      const reply = await this.client.call("FT.INFO", this.indexName) as unknown[];
      const idx = Array.isArray(reply) ? (reply as string[]).indexOf("attributes") : -1;
      const attrs = idx >= 0 && reply[idx + 1] !== undefined ? reply[idx + 1] : [];
      const list = Array.isArray(attrs) ? attrs : [];
      const hasLegacy = list.some((a: unknown) => {
        const pair = Array.isArray(a) ? a : [];
        const idIdx = pair.indexOf("identifier");
        return idIdx >= 0 && pair[idIdx + 1] === this.metadataKey;
      });
      return hasLegacy ? "legacy" : "default";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("unknown command")) {
        throw new Error(
          "Failed to run FT.INFO. Ensure a RediSearch-capable Redis instance: https://js.langchain.com/docs/integrations/vectorstores/redis/#setup"
        );
      }
      return "none";
    }
  }

  async createIndex(documents?: Document[], dimensions = 1536): Promise<void> {
    if (!this.customSchema?.length) {
      throw new Error(
        "RedisVectorStore requires customSchema (MetadataFieldSchema[]). Pass it in the configuration."
      );
    }
    const state = await this.checkIndexState();
    if (documents?.length) {
      const inferred = inferMetadataSchema(documents);
      if (checkForSchemaMismatch(this.customSchema, inferred)) {
        console.warn(
          "RedisVectorStore: custom schema does not match inferred document metadata schema. This may be acceptable but verify schema."
        );
      }
    }

    if (state !== "none") return;

    const prefix = this.createIndexOptions.PREFIX ?? this.keyPrefix;
    const schemaArgs = buildFtCreateSchemaArgs(
      this.vectorKey,
      this.contentKey,
      dimensions,
      this.indexOptions,
      this.customSchema
    );

    const createArgs = [
      "FT.CREATE",
      this.indexName,
      "ON",
      (this.createIndexOptions.ON as string) ?? "HASH",
      "PREFIX",
      1,
      prefix,
      "SCHEMA",
      ...schemaArgs,
    ] as const;

    try {
      await this.client.call(...createArgs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/index\s+already\s+exists/i.test(msg)) return;
      throw err;
    }
  }

  async dropIndex(deleteDocuments?: boolean): Promise<boolean> {
    try {
      if (deleteDocuments) {
        await this.client.call("FT.DROPINDEX", this.indexName, "DD");
      } else {
        await this.client.call("FT.DROPINDEX", this.indexName);
      }
      return true;
    } catch {
      return false;
    }
  }

  async delete(params: { deleteAll: boolean } | { ids: string[] }): Promise<void> {
    if ("deleteAll" in params && params.deleteAll) {
      await this.dropIndex(true);
    } else if ("ids" in params && params.ids?.length) {
      const keys = params.ids.map((id) => `${this.keyPrefix}${id}`);
      await this.client.del(...keys);
    } else {
      throw new Error('Invalid parameters passed to "delete".');
    }
  }

  private getFloat32Buffer(vector: number[]): Buffer {
    return Buffer.from(new Float32Array(vector).buffer);
  }
}
