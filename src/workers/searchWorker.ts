import { Worker, WorkerOptions } from "bullmq";
import type { AgentWorkerLogger, ModelOptions } from "../options.js";
import { QUEUE_NAMES } from "../options.js";
import type { SearchJobData, SearchJobResult } from "../queues/types.js";
import type { VectorStoreProvider } from "../rag/index.js";

export interface SearchWorkerParams {
  vectorStoreProvider: VectorStoreProvider;
  embeddingModelOptions: ModelOptions;
  logger: AgentWorkerLogger;
}

export class SearchWorker {
  private readonly vectorStoreProvider: VectorStoreProvider;
  private readonly embeddingModelOptions: ModelOptions;
  private readonly logger: AgentWorkerLogger;
  private readonly options: WorkerOptions;
  private _started = false;
  private worker: Worker<SearchJobData, SearchJobResult> | null = null;

  constructor(params: SearchWorkerParams, options: WorkerOptions) {
    this.vectorStoreProvider = params.vectorStoreProvider;
    this.embeddingModelOptions = params.embeddingModelOptions;
    this.logger = params.logger;
    this.options = options;
  }

  start() {
    if (this._started) return;
    this.worker = new Worker<SearchJobData, SearchJobResult>(
      QUEUE_NAMES.SEARCH,
      async (job) => {
        const { agentId, query, k = 5 } = job.data;
        const store = await this.vectorStoreProvider.getVectorStore(
          `${agentId}-rag`,
          this.embeddingModelOptions
        );
        const docs = await store.similaritySearch(query, k);
        const results = docs.map((d) => ({
          content: d.pageContent,
          metadata: (d.metadata ?? {}) as Record<string, unknown>,
        }));
        return { results, count: results.length };
      },
      { ...this.options }
    );

    this.worker.on("completed", (job) => {
      this.logger.debug(`[search] Job ${job.id} completed`);
    });
    this.worker.on("failed", (job, err) => {
      this.logger.error(`[search] Job ${job?.id} failed`, err);
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
