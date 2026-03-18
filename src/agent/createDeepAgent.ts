/**
 * Creates a Deep Agent with the same middleware stack as createDeepAgent except
 * filesystem tools (ls, read_file, write_file, edit_file, grep, glob, execute)
 * are omitted. Use this when the agent should not have access to filesystem
 * or shell tools.
 *
 * The default backend in createDeepAgent is StateBackend (in-memory); this
 * helper does not add any filesystem middleware, so no file tools are exposed
 * at all.
 */
import { Runnable } from "@langchain/core/runnables";
import type { CompiledSubAgent, CreateDeepAgentParams, SubAgent } from "deepagents";
import {
  createPatchToolCallsMiddleware,
  createSkillsMiddleware,
  createSubAgentMiddleware,
  StateBackend
} from "deepagents";
import {
  anthropicPromptCachingMiddleware,
  createAgent,
  humanInTheLoopMiddleware,
  SystemMessage,
  todoListMiddleware,
} from "langchain";
import { createAgentMemoryMiddleware, type AgentMemoryMiddlewareParams } from "./middlewares/agentMemory.js";
import { createHistoryMiddleware } from "./middlewares/history.js";
import { createProgressMiddleware } from "./middlewares/progress.js";
import { createSummarizationMiddleware, type SummarizationMiddlewareParams } from "./middlewares/summarization.js";
import { BASE_PROMPT } from "./prompts.js";

/** Subagent type: either a spec (SubAgent) or a pre-compiled runnable (CompiledSubAgent). */
type SubAgentOrCompiled = SubAgent | CompiledSubAgent;

/** Config passed to backend factories; matches CreateDeepAgentParams["backend"] callback argument. */
type BackendConfig = Parameters<Extract<NonNullable<CreateDeepAgentParams["backend"]>, Function>>[0];

function buildSystemPrompt(
  systemPrompt: CreateDeepAgentParams["systemPrompt"]
): string | InstanceType<typeof SystemMessage> {
  if (!systemPrompt) return BASE_PROMPT;
  if (typeof systemPrompt === "string") {
    return `${systemPrompt}\n\n${BASE_PROMPT}`;
  }
  return new SystemMessage({
    content: [
      { type: "text" as const, text: BASE_PROMPT },
      ...(typeof systemPrompt.content === "string"
        ? [{ type: "text" as const, text: systemPrompt.content }]
        : systemPrompt.content),
    ],
  });
}

/** Default backend factory: StateBackend from execution context (no host filesystem). */
function defaultBackendFactory(config: BackendConfig): InstanceType<typeof StateBackend> {
  return new StateBackend(config);
}

/** Params for createDeepAgent: deepagents params plus optional agentMemory and summarization. */
export type CreateDeepAgentParamsLocal = Omit<CreateDeepAgentParams, "memory"> & {
  /** When set, enables cross-thread agent memory (persisted by agentId). */
  agentMemory?: AgentMemoryMiddlewareParams;
  /** When set, enables history summarization when thread exceeds historyThreshold messages. */
  summarization?: SummarizationMiddlewareParams;
};

/**
 * Same as createDeepAgent but without filesystem middleware.
 * Accepts the same params; returns a runnable compatible with createDeepAgent.
 */
export function createDeepAgent(
  params: CreateDeepAgentParamsLocal = {}
): ReturnType<typeof createAgent> {
  const {
    // Default model string; only used if createDeepAgent is called without model. The orchestrator always passes an initialized chat model from initChatModel(provider:model, options).
    model = "claude-sonnet-4-5-20250929",
    tools = [],
    systemPrompt,
    middleware: customMiddleware = [],
    subagents = [],
    responseFormat,
    contextSchema,
    store,
    backend,
    interruptOn,
    name,
    skills,
    agentMemory,
    summarization,
  } = params;

  const finalSystemPrompt = buildSystemPrompt(systemPrompt);

  const backendFactory: NonNullable<CreateDeepAgentParams["backend"]> =
    backend ?? defaultBackendFactory;

  const skillsMiddlewareArray =
    skills != null && skills.length > 0
      ? [
        createSkillsMiddleware({
          backend: backendFactory,
          sources: skills,
        }),
      ]
      : [];

  const agentMemoryMiddlewareArray =
    agentMemory != null ? [createAgentMemoryMiddleware(agentMemory)] : [];
  const summarizationMiddlewareArray =
    summarization != null ? [createSummarizationMiddleware(summarization)] : [];

  const processedSubagents: SubAgentOrCompiled[] = subagents.map(
    (subagent: SubAgentOrCompiled): SubAgentOrCompiled => {
      if (Runnable.isRunnable(subagent)) return subagent;
      if (!("skills" in subagent) || !subagent.skills?.length) return subagent;
      const sa = subagent as SubAgent;
      const subagentSkillsMiddleware = createSkillsMiddleware({
        backend: backendFactory,
        sources: sa.skills ?? [],
      });
      return {
        ...sa,
        middleware: [subagentSkillsMiddleware, ...(sa.middleware ?? [])],
      };
    }
  );

  const subagentMiddlewareNoFs = [
    todoListMiddleware(),
    anthropicPromptCachingMiddleware({ unsupportedModelBehavior: "ignore" }),
    createPatchToolCallsMiddleware(),
  ];

  const toolsList = tools ? [...tools] : [];
  const toolsForSubAgents = toolsList as Parameters<typeof createSubAgentMiddleware>[0]["defaultTools"];

  const baseMiddleware = [
    createProgressMiddleware(),
    createHistoryMiddleware(),
    ...summarizationMiddlewareArray,
    ...agentMemoryMiddlewareArray,
    anthropicPromptCachingMiddleware({ unsupportedModelBehavior: "ignore" }),
    createPatchToolCallsMiddleware(),
    ...skillsMiddlewareArray,
    ...(interruptOn ? [humanInTheLoopMiddleware({ interruptOn })] : []),
    ...customMiddleware,
  ];

  const middleware = subagents.length > 0
    ? baseMiddleware
    : [
      todoListMiddleware(),
      createSubAgentMiddleware({
        defaultModel: model,
        defaultTools: toolsForSubAgents,
        defaultMiddleware: subagentMiddlewareNoFs,
        generalPurposeMiddleware: [
          ...subagentMiddlewareNoFs,
          ...skillsMiddlewareArray,
        ],
        defaultInterruptOn: interruptOn ?? null,
        subagents: processedSubagents,
        generalPurposeAgent: true,
      }),
      ...baseMiddleware,
    ];

  return createAgent({
    model,
    systemPrompt: finalSystemPrompt,
    tools: toolsList,
    middleware,
    ...(responseFormat != null && { responseFormat }),
    contextSchema,
    store,
    name,
  }).withConfig({ recursionLimit: 10_000 });
}
