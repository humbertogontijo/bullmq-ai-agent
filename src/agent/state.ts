import { BaseMessage } from "@langchain/core/messages";
import { Interrupt } from "@langchain/langgraph";
import type { TodoItem } from "../queues/types.js";

export type AgentState = {
  messages: BaseMessage[],
  todos?: TodoItem[],
  historyMessages?: BaseMessage[],
  __interrupt__?: Interrupt<AgentState>[],
};
