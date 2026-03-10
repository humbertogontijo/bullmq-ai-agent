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
