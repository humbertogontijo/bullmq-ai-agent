import { SystemMessage } from "@langchain/core/messages";
import { Job, Worker, WorkerOptions } from "bullmq";
import type { CompiledGraph } from "../agent/compile.js";
import { parseTimestampFromJobId, serializeAgentState } from "../agent/middlewares/history.js";
import { getLastJobAndReturnvalueScript } from "../commands/index.js";
import type { AgentWorkerLogger, GetTodosCallback, ModelOptions, RedisLike } from "../options.js";
import type { AgentMemoryStore } from "../memory/AgentMemoryStore.js";
import { buildRunContext, QUEUE_NAMES } from "../options.js";
import { buildJobIdPrefix, buildThreadJobsKey } from "../queues/queueKeys.js";
import type {
  AgentJobData,
  AgentJobResult,
  AgentResumeToolData,
  AgentRunData,
  StoredAgentState,
  StoredToolMessage,
} from "../queues/types.js";
import { getLastRequestHumanApprovalToolCall } from "../utils/message.js";
import { mapStoredMessagesToChatMessages } from "../utils/messageMapping.js";
import { AgentState } from "../agent/state.js";

export interface AgentWorkerParams {
  compiledGraph: CompiledGraph;
  /** Redis client (same as queue connection); used to load thread history via Lua script. */
  redis: RedisLike;
  /** BullMQ queue key prefix (e.g. "bull"); used for thread history key pattern. */
  queueKeyPrefix: string;
  /** Default chat model; merged with getAgentConfig(agentId) per run (agent config overrides). */
  chatModelOptions: ModelOptions;
  embeddingModelOptions?: ModelOptions;
  logger: AgentWorkerLogger;
  /** When set, passed to getPreviousReturnvalues Lua as max number of previous jobs to load. */
  maxHistoryMessages?: number;
  /** Cross-thread memory store. Set by BullMQAgentWorker when enableAgentMemory is on. */
  agentMemoryStore?: AgentMemoryStore;
  /** Callback returning initial required todos. Passed to RunContext for the TodoPersistenceMiddleware. */
  getTodos?: GetTodosCallback;
}

export class AgentWorker {
  private readonly compiledGraph: CompiledGraph;
  private readonly redis: RedisLike;
  private readonly queueKeyPrefix: string;
  private readonly chatModelOptions: ModelOptions;
  private readonly embeddingModelOptions: ModelOptions | undefined;
  private readonly logger: AgentWorkerLogger;
  private readonly maxHistoryMessages: number | undefined;
  private readonly agentMemoryStore: AgentMemoryStore | undefined;
  private readonly getTodos: GetTodosCallback | undefined;
  private readonly options: WorkerOptions;
  private _started = false;
  private worker: Worker<AgentJobData, AgentJobResult> | null = null;

  constructor(params: AgentWorkerParams, options: WorkerOptions) {
    this.compiledGraph = params.compiledGraph;
    this.redis = params.redis;
    this.queueKeyPrefix = params.queueKeyPrefix;
    this.chatModelOptions = params.chatModelOptions;
    this.embeddingModelOptions = params.embeddingModelOptions;
    this.logger = params.logger;
    this.maxHistoryMessages = params.maxHistoryMessages;
    this.agentMemoryStore = params.agentMemoryStore;
    this.getTodos = params.getTodos;
    this.options = options;
  }

  /** Process a single agent job (run or resumeTool). History is loaded by history middleware for run; resumeTool uses last job state. */
  async processJob(job: Job<AgentJobData, AgentJobResult>): Promise<AgentJobResult> {
    const data = job.data;
    const threadId = data.threadId;
    const agentId = data.agentId;
    const contactId = data.contactId ?? threadId;
    const subagentId = data.subagentId;

    const systemParts: InstanceType<typeof SystemMessage>[] = [];

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
    const chatModelOptions = effectiveChatModelOptions;

    const configurable = buildRunContext({
      job,
      agentId,
      thread_id: threadId,
      contactId,
      chatModelOptions,
      embeddingModelOptions: this.embeddingModelOptions,
      metadata: data.metadata,
      redis: this.redis,
      queueKeyPrefix: this.queueKeyPrefix,
      maxHistoryMessages: this.maxHistoryMessages,
      agentMemoryStore: this.agentMemoryStore,
      getTodos: this.getTodos,
    });

    let inputStored: StoredAgentState["messages"];
    if (job.name === "resumeTool") {
      const resumeData = data as AgentResumeToolData;
      const threadJobsKey = buildThreadJobsKey(this.queueKeyPrefix, QUEUE_NAMES.AGENT, threadId);
      const jobIdPrefix = buildJobIdPrefix(this.queueKeyPrefix, QUEUE_NAMES.AGENT);
      const raw = (await this.redis.eval(
        getLastJobAndReturnvalueScript,
        1,
        threadJobsKey,
        jobIdPrefix
      )) as [string, string] | [];
      if (!raw || raw.length < 2) {
        throw new Error(`No previous job found for thread ${threadId}; cannot resumeTool.`);
      }
      const [, returnvalueStr] = raw;
      let lastState: AgentJobResult;
      try {
        lastState = JSON.parse(returnvalueStr || "{}") as AgentJobResult;
      } catch {
        throw new Error(`Invalid return value from previous job for thread ${threadId}.`);
      }
      const lastMessages = lastState?.messages ?? [];
      const toolCall = getLastRequestHumanApprovalToolCall(lastMessages);
      if (!toolCall?.id) {
        throw new Error(`Last job for thread ${threadId} has no pending tool calls.`);
      }
      const toolMessage: StoredToolMessage = {
        type: "tool",
        data: {
          content: resumeData.content,
          tool_call_id: toolCall.id,
          name: toolCall.name,
        },
      };
      inputStored = [toolMessage];
    } else {
      const runData = data as AgentRunData;
      inputStored = runData.input?.messages ?? [];
    }

    let messages = mapStoredMessagesToChatMessages(inputStored);
    if (systemParts.length) {
      messages = [...systemParts, ...messages];
    }
    const runnable = await this.compiledGraph.getRunnable(subagentId, chatModelOptions);
    const streamConfig = {
      configurable,
      // Middleware hooks receive config.context as runtime.context (LangChain does not pass configurable to runtime).
      context: configurable,
    };

    const state: AgentState = await runnable.invoke({ messages }, streamConfig);
    if (!state) {
      return { messages: [] };
    }

    // Register this job in the thread-jobs set so resumeTool and history ccan use it. Skip for ephemeral subagents (suggestions, reply-draft).
    const isEphemeral = data.subagentId && this.compiledGraph.isEphemeralSubagent?.(data.subagentId);
    if (!isEphemeral) {
      const threadJobsKey = buildThreadJobsKey(this.queueKeyPrefix, QUEUE_NAMES.AGENT, threadId);
      const ts = parseTimestampFromJobId(String(job.id));
      const score = Number.isNaN(ts) ? Date.now() : ts;
      await this.redis.zadd(threadJobsKey, score, String(job.id));
    }

    return serializeAgentState({
      // Exclude system messages from the stored state so they are not persisted in job history.
      messages: (state.messages ?? []).filter(
        (m) => !SystemMessage.isInstance(m)
      )
    });
  }

  start() {
    if (this._started) return;
    this.worker = new Worker<AgentJobData, AgentJobResult>(
      QUEUE_NAMES.AGENT,
      (job) => this.processJob(job),
      { ...this.options }
    );

    this.worker.on("completed", async (job) => {
      this.logger.debug(`[agent] Job ${job.id} (${job.name}) completed`);
      const isEphemeral = job.data.subagentId && this.compiledGraph.isEphemeralSubagent?.(job.data.subagentId);
      if (isEphemeral) {
        await job.remove();
      }
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
