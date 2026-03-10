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
import {
  createAgent,
  SystemMessage,
  todoListMiddleware,
  anthropicPromptCachingMiddleware,
  humanInTheLoopMiddleware,
} from "langchain";
import type { CreateDeepAgentParams, SubAgent, CompiledSubAgent } from "deepagents";
import {
  createSubAgentMiddleware,
  createSummarizationMiddleware,
  createPatchToolCallsMiddleware,
  StateBackend,
  createSkillsMiddleware,
  createMemoryMiddleware,
} from "deepagents";

const BASE_PROMPT =
  "In order to complete the objective that the user asks of you, you have access to a number of standard tools.";

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

/**
 * Same as createDeepAgent but without filesystem middleware.
 * Accepts the same params; returns a runnable compatible with createDeepAgent.
 */
export function createDeepAgent(
  params: CreateDeepAgentParams = {}
): ReturnType<typeof createAgent> {
  const {
    model = "claude-sonnet-4-5-20250929",
    tools = [],
    systemPrompt,
    middleware: customMiddleware = [],
    subagents = [],
    responseFormat,
    contextSchema,
    checkpointer,
    store,
    backend,
    interruptOn,
    name,
    memory,
    skills,
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

  const memoryMiddlewareArray =
    memory != null && memory.length > 0
      ? [
        createMemoryMiddleware({
          backend: backendFactory,
          sources: memory,
        }),
      ]
      : [];

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
    createSummarizationMiddleware({
      model,
      backend: backendFactory,
    }),
    anthropicPromptCachingMiddleware({ unsupportedModelBehavior: "ignore" }),
    createPatchToolCallsMiddleware(),
  ];

  const toolsList = tools ? [...tools] : [];
  const toolsForSubAgents = toolsList as Parameters<typeof createSubAgentMiddleware>[0]["defaultTools"];

  return createAgent({
    model,
    systemPrompt: finalSystemPrompt,
    tools: toolsList,
    middleware: [
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
      createSummarizationMiddleware({
        model,
        backend: backendFactory,
      }),
      anthropicPromptCachingMiddleware({ unsupportedModelBehavior: "ignore" }),
      createPatchToolCallsMiddleware(),
      ...skillsMiddlewareArray,
      ...memoryMiddlewareArray,
      ...(interruptOn ? [humanInTheLoopMiddleware({ interruptOn })] : []),
      ...customMiddleware,
    ],
    ...(responseFormat != null && { responseFormat }),
    contextSchema,
    checkpointer,
    store,
    name,
  }).withConfig({ recursionLimit: 10_000 });
}
