import { mapStoredMessagesToChatMessages } from "@langchain/core/messages";
import { Job, Worker, WorkerOptions } from "bullmq";
import { CompiledGraph } from "../agent/compile.js";
import type { AgentWorkerLogger, ModelOptions } from "../options.js";
import { QUEUE_NAMES, RunContext } from "../options.js";
import type { AgentJobData, AgentJobResult, AgentResumeData, AgentRunData } from "../queues/types.js";
import { getLastAIMessage } from "../utils/message.js";
import type { ResumeWorker } from "./resumeWorker.js";

export interface AgentWorkerParams {
  compiledGraph: CompiledGraph;
  resumeWorker: ResumeWorker;
  embeddingModelOptions: ModelOptions;
  logger: AgentWorkerLogger;
}

export class AgentWorker {
  private readonly compiledGraph: CompiledGraph;
  private readonly resumeWorker: ResumeWorker;
  private readonly embeddingModelOptions: ModelOptions;
  private readonly logger: AgentWorkerLogger;
  private readonly options: WorkerOptions;
  private _started = false;
  private worker: Worker<AgentJobData, AgentJobResult> | null = null;

  constructor(params: AgentWorkerParams, options: WorkerOptions) {
    this.compiledGraph = params.compiledGraph;
    this.resumeWorker = params.resumeWorker;
    this.embeddingModelOptions = params.embeddingModelOptions;
    this.logger = params.logger;
    this.options = options;
  }

  /** Process a single agent job (run or resume). Uses shared graph from resumeWorker. */
  async processJob(job: Job<AgentJobData, AgentJobResult>): Promise<AgentJobResult> {
    const data = job.data;
    const threadId = data.threadId;
    const agentId = data.agentId;
    const configurable: RunContext = { thread_id: threadId, agentId, job, embeddingModelOptions: this.embeddingModelOptions };

    if (job.name === "run") {
      const runData = job.data as AgentRunData;
      const messages = mapStoredMessagesToChatMessages(runData.input?.messages ?? []);
      const state = await this.compiledGraph.invoke(
        { messages },
        { configurable: { ...configurable, goalId: runData.goalId, chatModelOptions: runData.chatModelOptions } }
      );
      const [interrupt] = state["__interrupt__"] ?? [];
      if (interrupt) {
        return { status: "interrupted", interruptPayload: interrupt.value };
      }
      const lastAIMessageContent = getLastAIMessage(state.messages ?? [])?.content
      return { status: "completed", lastMessage: lastAIMessageContent ? JSON.stringify(lastAIMessageContent) : undefined };
    }

    if (job.name === "resume") {
      const resumeData = job.data as AgentResumeData;
      return this.resumeWorker.runResume(configurable, resumeData.result);
    }

    return { status: "completed" };
  }

  start() {
    if (this._started) return;
    this.worker = new Worker<AgentJobData, AgentJobResult>(
      QUEUE_NAMES.AGENT,
      (job) => this.processJob(job),
      { ...this.options }
    );

    this.worker.on("completed", (job) => {
      this.logger.debug(`[agent] Job ${job.id} (${job.name}) completed`);
    });
    this.worker.on("failed", (job, err) => {
      this.logger.error(`[agent] Job ${job?.id} (${job?.name}) failed`, err);
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
