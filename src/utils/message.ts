import { AIMessage, BaseMessage, ToolCall } from "@langchain/core/messages";
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

