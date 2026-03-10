import type { SystemMessageFields } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { CompiledSubAgent, createDeepAgent, type CreateDeepAgentParams } from "deepagents";
import { initChatModel, SystemMessage } from "langchain";
import type { AgentConfig, ModelOptions, Skill } from "../options.js";
import type { RedisSaver } from "../redis/RedisSaver.js";
import { createProgressMiddleware } from "./progress.js";

type TRunnable = CompiledSubAgent["runnable"]

/** Subagent: name, description, system prompt, and optional tools/model. When subagentId is set, that subagent runs directly. */
export interface Subagent {
  name: string;
  description: string;
  systemPrompt: SystemMessageFields;
  tools?: StructuredToolInterface[];
  model?: ModelOptions;
  /** When true, this subagent's messages are not committed to the thread. Use for suggestions, autocomplete, or reply-draft subagents. Direct runs already omit checkpointer when ephemeral; future main-agent delegation may skip merging ephemeral subagent messages. */
  ephemeral?: boolean;
}

export type CompileGraphOptions = OrchestratorContext & {
  checkpointer: RedisSaver;
};

/** Context bound when building the graph (worker-held tools, checkpointer, optional subagents, optional skills). */
export interface OrchestratorContext {
  tools: StructuredToolInterface[];
  /** Subagent specs for the main agent; when run/resume sets subagentId, that subagent's runnable is created via createDeepAgentRunnable and invoked. */
  subagents?: Subagent[];
  /** System prompt for the main agent when there is no subagentId in the request. */
  systemPrompt?: SystemMessageFields;
  /** Async function returning per-agent config (systemPrompt, default model/temperature). Prepended at invoke time; run's chatModelOptions override. */
  getAgentConfig?: (agentId: string) => Promise<AgentConfig | undefined>;
  /** Optional skills for progressive disclosure; descriptions are injected into system prompt, load_skill tool loads full content. */
  skills?: Skill[];
}

/** Cache key for runnable cache (subagentId + model options). */
function runnableCacheKey(subagentId: string | undefined, opts: ModelOptions): string {
  return `${subagentId ?? "main"}:${opts.provider}:${opts.model}:${opts.apiKey?.slice(0, 8) ?? ""}`;
}

/** Wrapper around createDeepAgent that returns Runnable to avoid TS2589 (excessively deep type instantiation). */
function createDeepAgentRunnable(params?: CreateDeepAgentParams): TRunnable {
  return createDeepAgent(params as never) as unknown as TRunnable;
}

/** Build a runnable (main agent or subagent) for the given subagentId and model options. */
async function createRunnable(
  ctx: CompileGraphOptions,
  subagentId: string | undefined,
  chatModelOptions: ModelOptions
): Promise<TRunnable> {
  const { tools, subagents, checkpointer, systemPrompt } = ctx;
  const compiledSubagents = await Promise.all(subagents?.map(async (subagent) => {
    const subagentModel = subagent.model ?? chatModelOptions;
    const chaModel = await initChatModel(`${subagentModel.provider}:${subagentModel.model}`, {
      apiKey: subagentModel.apiKey,
      temperature: subagentModel.temperature,
      maxTokens: subagentModel.maxTokens,
    });
    const runnable = createDeepAgentRunnable({
      model: chaModel,
      tools: subagent.tools,
      systemPrompt: new SystemMessage(subagent.systemPrompt),
      checkpointer: !subagent.ephemeral ? checkpointer : undefined,
    });
    return {
      name: subagent.name,
      description: subagent.description,
      runnable,
    } as CompiledSubAgent;
  }) ?? []);

  if (subagentId) {
    const subagent = compiledSubagents?.find((g) => g.name === subagentId);
    if (!subagent) throw new Error(`Unknown subagentId: ${subagentId}`);
    return subagent.runnable;
  }

  const { provider, model, ...options } = chatModelOptions;
  const chatModel = await initChatModel(`${chatModelOptions.provider}:${chatModelOptions.model}`, options);

  return createDeepAgentRunnable({
    model: chatModel,
    tools,
    systemPrompt: systemPrompt ? new SystemMessage(systemPrompt) : "",
    subagents: compiledSubagents,
    checkpointer,
    middleware: [createProgressMiddleware()]
  });
}

export interface OrchestratorRunnables {
  /** Get the runnable for the given subagentId (undefined = main agent) and model options. Cached per (subagentId, model). */
  getRunnable(subagentId: string | undefined, chatModelOptions: ModelOptions): Promise<TRunnable>;
}

/** Build orchestrator runnables: main deep agent + subagent runnables. Tools run in-process. */
export function buildOrchestratorRunnables(
  ctx: CompileGraphOptions
): OrchestratorRunnables {
  const cache = new Map<string, TRunnable>();

  return {
    async getRunnable(subagentId: string | undefined, chatModelOptions: ModelOptions): Promise<TRunnable> {
      const key = runnableCacheKey(subagentId, chatModelOptions);
      let runnable = cache.get(key);
      if (!runnable) {
        runnable = await createRunnable(ctx, subagentId, chatModelOptions);
        cache.set(key, runnable);
      }
      return runnable;
    },
  };
}
