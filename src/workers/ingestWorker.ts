import { inferMetadataSchema } from "@langchain/redis";
import { Worker, WorkerOptions } from "bullmq";
import type { AgentWorkerLogger, ModelOptions } from "../options.js";
import { QUEUE_NAMES } from "../options.js";
import type { IngestJobData } from "../queues/types.js";
import {
  type VectorStoreProvider
} from "../rag/index.js";
import { loadDocumentsFromSource } from "../rag/loadDocument.js";
import { splitDocuments } from "../rag/splitDocuments.js";

export interface IngestWorkerParams {
  vectorStoreProvider: VectorStoreProvider;
  embeddingModelOptions: ModelOptions;
  logger: AgentWorkerLogger;
}

export class IngestWorker {
  private readonly vectorStoreProvider: VectorStoreProvider;
  private readonly embeddingModelOptions: ModelOptions;
  private readonly logger: AgentWorkerLogger;
  private readonly options: WorkerOptions;
  private _started = false;
  private worker: Worker<IngestJobData> | null = null;

  constructor(params: IngestWorkerParams, options: WorkerOptions) {
    this.vectorStoreProvider = params.vectorStoreProvider;
    this.embeddingModelOptions = params.embeddingModelOptions;
    this.logger = params.logger;
    this.options = options;
  }

  start() {
    if (this._started) return;
    this.worker = new Worker<IngestJobData>(
      QUEUE_NAMES.INGEST,
      async (job) => {
        const { agentId, source } = job.data;
        const documents = await loadDocumentsFromSource(source);
        const splits = await splitDocuments(documents);
        const inferredSchema = inferMetadataSchema(splits);
        const store = await this.vectorStoreProvider.getVectorStore(`${agentId}-rag`, this.embeddingModelOptions, inferredSchema);
        await store.addDocuments(splits, inferredSchema);
        return { ingested: documents.length };
      },
      { ...this.options }
    );

    this.worker.on("completed", (job) => {
      this.logger.debug(`[ingest] Job ${job.id} completed`);
    });
    this.worker.on("failed", (job, err) => {
      this.logger.error(`[ingest] Job ${job?.id} failed`, err);
    });

    this._started = true;
  }

  async close(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
  }
}
