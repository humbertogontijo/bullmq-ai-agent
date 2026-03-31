import { tool, type ToolRuntime } from "@langchain/core/tools";
import { GraphInterrupt } from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import type { AgentJobResult, StoredAIMessage } from "../../queues/types.js";
import { SUGGEST_RESPONSE_SUGGESTION_DESCRIPTION, SUGGEST_RESPONSE_TOOL_DESCRIPTION } from "../prompts.js";
import { AgentState } from "../state.js";

/** Synthetic tool name: the worker wraps plain AI text as this tool call in suggest mode (not invoked by the model). */
export const SUGGEST_RESPONSE_TOOL_NAME = "suggest_response";

const suggestResponseSchema = {
  type: "object" as const,
  properties: {
    suggestion: {
      type: "string" as const,
      description: SUGGEST_RESPONSE_SUGGESTION_DESCRIPTION,
    },
  },
  required: ["suggestion"],
} as const;

/**
 * Schema reference for `suggest_response` (same shape as worker-injected synthetic tool calls).
 * Not added to the default agent tool list; use for documentation, tests, or custom graphs.
 */
export const suggestion = tool(
  async (_input, runtime: ToolRuntime<AgentState>) => {
    throw new GraphInterrupt([{ value: runtime.state }]);
  },
  {
    name: SUGGEST_RESPONSE_TOOL_NAME,
    description: SUGGEST_RESPONSE_TOOL_DESCRIPTION,
    schema: suggestResponseSchema,
  },
);

/**
 * If the last AI message has no tool_calls, convert it into a suggest_response tool call
 * so the client sees isResumeRequired=true and can approve/edit via resumeTool.
 */
export function convertToSuggestion(result: AgentJobResult): AgentJobResult {
  const messages = [...result.messages];
  const lastIdx = messages.length - 1;
  const last = messages[lastIdx];
  if (last?.type !== "ai") return result;

  const existingToolCalls = last.data?.tool_calls;
  if (existingToolCalls?.length) return result;

  const originalContent = typeof last.data?.content === "string"
    ? last.data.content
    : JSON.stringify(last.data?.content ?? "");

  const suggestionMessage: StoredAIMessage = {
    type: "ai",
    data: {
      content: "",
      tool_calls: [{
        name: SUGGEST_RESPONSE_TOOL_NAME,
        id: randomUUID(),
        args: { suggestion: originalContent },
        type: "tool_call" as const,
      }],
    },
  };
  messages[lastIdx] = suggestionMessage;
  return { ...result, messages };
}
