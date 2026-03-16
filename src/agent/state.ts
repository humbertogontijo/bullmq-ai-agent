import { BaseMessage } from "@langchain/core/messages";
import { Interrupt } from "@langchain/langgraph";

export type AgentState = {
  messages: BaseMessage[],
  historyMessages?: BaseMessage[],
  __interrupt__?: Interrupt<AgentState>[],
};
