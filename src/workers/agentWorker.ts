import { mapStoredMessagesToChatMessages, SystemMessage } from "@langchain/core/messages";
import { Job, Worker, WorkerOptions } from "bullmq";
import type { CompiledGraph } from "../agent/compile.js";
import type { AgentWorkerLogger, ModelOptions } from "../options.js";
import { QUEUE_NAMES, RunContext } from "../options.js";
import type { AgentJobData, AgentJobResult, AgentResumeData, AgentRunData, HumanInterruptPayload } from "../queues/types.js";
import { getLastAIMessage } from "../utils/message.js";
import type { ResumeWorker } from "./resumeWorker.js";

export interface AgentWorkerParams {
  compiledGraph: CompiledGraph;
  resumeWorker: ResumeWorker;
  /** Default chat model; merged with getAgentConfig(agentId) per run (agent config overrides). */
  chatModelOptions: ModelOptions;
  embeddingModelOptions: ModelOptions;
  logger: AgentWorkerLogger;
}

export class AgentWorker {
  private readonly compiledGraph: CompiledGraph;
  private readonly resumeWorker: ResumeWorker;
  private readonly chatModelOptions: ModelOptions;
  private readonly embeddingModelOptions: ModelOptions;
  private readonly logger: AgentWorkerLogger;
  private readonly options: WorkerOptions;
  private _started = false;
  private worker: Worker<AgentJobData, AgentJobResult> | null = null;

  constructor(params: AgentWorkerParams, options: WorkerOptions) {
    this.compiledGraph = params.compiledGraph;
    this.resumeWorker = params.resumeWorker;
    this.chatModelOptions = params.chatModelOptions;
    this.embeddingModelOptions = params.embeddingModelOptions;
    this.logger = params.logger;
    this.options = options;
  }

  /** Process a single agent job (run or resume). Uses getRunnable(subagentId, chatModelOptions) for main or subagent. */
  async processJob(job: Job<AgentJobData, AgentJobResult>): Promise<AgentJobResult> {
    const data = job.data;
    const threadId = data.threadId;
    const agentId = data.agentId;
    const configurable: RunContext = { thread_id: threadId, agentId, job, embeddingModelOptions: this.embeddingModelOptions, metadata: data.metadata };

    if (job.name === "run") {
      const runData = job.data as AgentRunData;
      let messages = mapStoredMessagesToChatMessages(runData.input?.messages ?? []);
      const systemParts: InstanceType<typeof SystemMessage>[] = [];
      if (this.compiledGraph.getSkillsPrompt) {
        systemParts.push(new SystemMessage(this.compiledGraph.getSkillsPrompt()));
      }
      let effectiveChatModelOptions: ModelOptions = { ...this.chatModelOptions };
      if (this.compiledGraph.getAgentConfig) {
        const config = await this.compiledGraph.getAgentConfig(agentId);
        if (config?.systemPrompt) {
          const fields = Array.isArray(config.systemPrompt) ? config.systemPrompt : [config.systemPrompt];
          systemParts.push(...fields.map((s) => new SystemMessage(s)));
        }
        if (config?.model || config?.temperature != null || config?.maxTokens != null) {
          effectiveChatModelOptions = {
            ...this.chatModelOptions,
            ...config.model,
            temperature: config.temperature ?? config.model?.temperature ?? this.chatModelOptions.temperature,
            maxTokens: config.maxTokens ?? config.model?.maxTokens ?? this.chatModelOptions.maxTokens,
          } as ModelOptions;
        }
      }
      if (systemParts.length) {
        messages = [...systemParts, ...messages];
      }
      const chatModelOptions = effectiveChatModelOptions;
      const subagentId = runData.subagentId;
      const runnable = await this.compiledGraph.getRunnable(subagentId, chatModelOptions);
      const stream = await runnable.stream(
        { messages },
        { configurable: { ...configurable, subagentId, chatModelOptions } }
      );
      let state: Awaited<ReturnType<typeof runnable.invoke>> | undefined;
      for await (const chunk of stream) {
        state = chunk;
      }
      if (state == null) {
        return { status: "completed" };
      }
      const [interrupt] = state["__interrupt__"] ?? [];
      if (interrupt) {
        const interruptPayload = interrupt.value;
        return {
          status: "interrupted",
          interruptPayload,
        };
      }
      const lastAIMessageContent = getLastAIMessage(state.messages ?? [])?.content;
      return { status: "completed", lastMessage: lastAIMessageContent ? JSON.stringify(lastAIMessageContent) : undefined };
    }

    if (job.name === "resume") {
      const resumeData = job.data as AgentResumeData;
      let chatModelOptions: ModelOptions = { ...this.chatModelOptions };
      if (this.compiledGraph.getAgentConfig) {
        const config = await this.compiledGraph.getAgentConfig(agentId);
        if (config?.model) {
          chatModelOptions = { ...this.chatModelOptions, ...config.model } as ModelOptions;
        }
      }
      const subagentId = resumeData.subagentId;
      return this.resumeWorker.runResume(configurable, resumeData.result, subagentId, chatModelOptions);
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
