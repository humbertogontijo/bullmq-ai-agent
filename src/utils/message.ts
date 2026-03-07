import { AIMessage, BaseMessage, ToolMessage } from "@langchain/core/messages";

export function getLastAIMessage(messages: BaseMessage[]): AIMessage | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (AIMessage.isInstance(m)) {
            return m;
        }
    }
    return null;
}

export function getToolCallIdsWithResponses(messages: BaseMessage[]): Set<string> {
    const ids = new Set<string>();
    for (const m of messages) {
        if (ToolMessage.isInstance(m) && m.tool_call_id) {
            ids.add(m.tool_call_id);
        }
    }
    return ids;
}
