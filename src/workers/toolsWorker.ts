import type { StoredMessage } from "@langchain/core/messages";
import { StructuredToolInterface } from "@langchain/core/tools";
import { Worker, WorkerOptions } from "bullmq";
import type { Goal } from "../agent/orchestrator.js";
import type { AgentWorkerLogger, ModelOptions } from "../options.js";
import { QUEUE_NAMES, RunContext } from "../options.js";
import type { ToolJobData } from "../queues/types.js";

export interface ToolsWorkerParams {
  tools: StructuredToolInterface[];
  /** When set, goal tools are merged only for the job's goalId (when job has goalId). */
  goals?: Goal[];
  embeddingModelOptions: ModelOptions;
  logger: AgentWorkerLogger;
}

export class ToolsWorker {
  private readonly tools: StructuredToolInterface[];
  private readonly goals: Goal[] | undefined;
  private readonly embeddingModelOptions: ModelOptions;
  private readonly logger: AgentWorkerLogger;
  private readonly options: WorkerOptions;
  private _started = false;
  private worker: Worker<ToolJobData> | null = null;

  constructor(params: ToolsWorkerParams, options: WorkerOptions) {
    this.tools = params.tools;
    this.goals = params.goals;
    this.embeddingModelOptions = params.embeddingModelOptions;
    this.logger = params.logger;
    this.options = options;
  }

  start() {
    if (this._started) return;
    this.worker = new Worker<ToolJobData>(
      QUEUE_NAMES.TOOLS,
      async (job) => {
        const { agentId, toolName, args, toolCallId, threadId } = job.data;
        const tool = this.tools.find((t) => t.name === toolName);
        let result: unknown;
        if (tool) {
          const runConfig: { configurable: RunContext } = { configurable: { thread_id: threadId, agentId, job, embeddingModelOptions: this.embeddingModelOptions } };
          result = await tool.invoke(args, runConfig);
        } else {
          result = { error: `Unknown tool: ${toolName}` };
        }
        const content = typeof result === "string" ? result : result != null ? JSON.stringify(result) : "";
        const storedMessage: StoredMessage = {
          type: "tool",
          data: { content, role: undefined, name: undefined, tool_call_id: toolCallId },
        };
        return storedMessage;
      },
      { ...this.options }
    );

    this.worker.on("completed", (job) => {
      this.logger.debug(`[tools] Job ${job.id} (${job.data.toolName}) completed`);
    });
    this.worker.on("failed", (job, err) => {
      this.logger.error(`[tools] Job ${job?.id} failed`, err);
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
