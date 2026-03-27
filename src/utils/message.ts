import { AIMessage, BaseMessage, ToolCall } from "@langchain/core/messages";
import { SUGGEST_RESPONSE_TOOL_NAME } from "../agent/tools/suggestion.js";
import type { StoredAgentState, StoredMessage } from "../queues/types.js";

/**
 * Returns the tool_call_id of the last AI message's request_human_approval tool call, or null.
 * Used by the worker for resumeTool.
 */
export function getLastRequestHumanApprovalToolCall(messages: StoredMessage[]): ToolCall | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.type === "ai" && Array.isArray((m.data as { tool_calls?: Array<{ id: string; name: string }> })?.tool_calls)) {
      const [toolCall] = m.data.tool_calls ?? [];
      return toolCall
    }
  }
}

export function getLastAIMessage(messages: BaseMessage[]): AIMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (AIMessage.isInstance(m)) {
      return m;
    }
  }
  return null;
}

export function isResumeRequired(chunk: StoredAgentState | null | undefined): boolean {
  const messages = chunk?.messages ?? [];
  const last = messages[messages.length - 1];
  if (last?.type !== "ai") return false;
  return !!last.data?.tool_calls?.length;
}

/** Returns true when the result is a suggest-mode response awaiting human approval. */
export function isSuggestion(chunk: StoredAgentState | null | undefined): boolean {
  const messages = chunk?.messages ?? [];
  const last = messages[messages.length - 1];
  if (last?.type !== "ai") return false;
  const toolCalls = last.data?.tool_calls;
  return toolCalls?.some((tc) => tc.name === SUGGEST_RESPONSE_TOOL_NAME) ?? false;
}

/** Extracts the AI's suggested response text from a suggest_response tool call. Returns undefined if not a suggestion. */
export function getSuggestionContent(chunk: StoredAgentState | null | undefined): string | undefined {
  const messages = chunk?.messages ?? [];
  const last = messages[messages.length - 1];
  if (last?.type !== "ai") return undefined;
  const toolCalls = last.data?.tool_calls;
  const tc = toolCalls?.find((t) => t.name === SUGGEST_RESPONSE_TOOL_NAME);
  return tc?.args?.suggestion;
}

