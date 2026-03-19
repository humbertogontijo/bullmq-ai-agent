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
import type { CreateDeepAgentParams } from "deepagents";
import {
  createPatchToolCallsMiddleware,
  createSubAgentMiddleware,
  StateBackend
} from "deepagents";
import {
  anthropicPromptCachingMiddleware,
  createAgent,
  humanInTheLoopMiddleware,
  SystemMessage,
} from "langchain";
import type { VectorStoreProviderInterface } from "../rag/index.js";
import { createAgentMemoryMiddleware, type AgentMemoryMiddlewareParams } from "./middlewares/agentMemory.js";
import { createHistoryMiddleware } from "./middlewares/history.js";
import { createProgressMiddleware } from "./middlewares/progress.js";
import { createSummarizationMiddleware, type SummarizationMiddlewareParams } from "./middlewares/summarization.js";
import { createTodoListMiddleware } from "./middlewares/todos.js";
import { BASE_PROMPT, RETRIEVE_SYSTEM_PROMPT } from "./prompts.js";
import { createRetrieveTool } from "./tools/retrieve.js";

/** Config passed to backend factories; matches CreateDeepAgentParams["backend"] callback argument. */
type BackendConfig = Parameters<Extract<NonNullable<CreateDeepAgentParams["backend"]>, Function>>[0];

function buildSystemPrompt(
  systemPrompt: CreateDeepAgentParams["systemPrompt"],
  prependRetrievePrompt: boolean
): string | InstanceType<typeof SystemMessage> {
  const base = prependRetrievePrompt ? RETRIEVE_SYSTEM_PROMPT : BASE_PROMPT;
  if (!systemPrompt) return base;
  if (typeof systemPrompt === "string") {
    return `${systemPrompt}\n\n${base}`;
  }
  return new SystemMessage({
    content: [
      { type: "text" as const, text: base },
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

/** RAG config: when set, the retrieve tool and RAG system prompt are added to the agent. */
export type RagParams = {
  vectorStoreProvider: VectorStoreProviderInterface;
};

/** Params for createDeepAgent: deepagents params plus optional agentMemory, summarization, and rag. */
export type CreateDeepAgentParamsLocal = Omit<CreateDeepAgentParams, "memory"> & {
  /** When set, enables cross-thread agent memory (persisted by agentId). */
  agentMemory?: AgentMemoryMiddlewareParams;
  /** When set, enables history summarization when thread exceeds historyThreshold messages. */
  summarization?: SummarizationMiddlewareParams;
  /** When set, adds the retrieve tool and RAG system prompt (requires embeddingModelOptions in run configurable). */
  rag?: RagParams;
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
    agentMemory,
    summarization,
    rag,
  } = params;

  const finalSystemPrompt = buildSystemPrompt(systemPrompt, !!rag);

  const agentMemoryMiddlewareArray =
    agentMemory != null ? [createAgentMemoryMiddleware(agentMemory)] : [];
  const summarizationMiddlewareArray =
    summarization != null ? [createSummarizationMiddleware(summarization)] : [];

  const subagentMiddleware = [
    createTodoListMiddleware(),
    anthropicPromptCachingMiddleware({ unsupportedModelBehavior: "ignore" }),
    createPatchToolCallsMiddleware(),
  ];

  const toolsList = tools ? [...tools] : []
  if (rag) {
    toolsList.unshift(createRetrieveTool(rag.vectorStoreProvider));
  }
  const toolsForSubAgents = toolsList as Parameters<typeof createSubAgentMiddleware>[0]["defaultTools"];

  const baseMiddleware = [
    createProgressMiddleware(),
    createHistoryMiddleware(),
    ...summarizationMiddlewareArray,
    ...agentMemoryMiddlewareArray,
    ...subagentMiddleware,
    ...(interruptOn ? [humanInTheLoopMiddleware({ interruptOn })] : []),
    ...customMiddleware,
  ];

  const middleware = subagents.length > 0
    ? [
      createSubAgentMiddleware({
        defaultModel: model,
        defaultTools: toolsForSubAgents,
        defaultMiddleware: subagentMiddleware,
        generalPurposeMiddleware: subagentMiddleware,
        defaultInterruptOn: interruptOn,
        subagents: [...subagents],
        generalPurposeAgent: true,
      }),
      ...baseMiddleware,
    ]
    : baseMiddleware;

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
