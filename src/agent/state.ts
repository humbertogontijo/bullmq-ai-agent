import { BaseMessage } from "@langchain/core/messages";
import { Interrupt } from "@langchain/langgraph";
import type { TodoItem, TodoSequenceSpec } from "../queues/types.js";

export type AgentState = {
  messages: BaseMessage[],
  todos?: TodoItem[],
  /**
   * Raw `(TodoItem | TodoItemsGraph)[]` from the single `getTodos` call at `beforeAgent`, kept for the
   * run so each `beforeModel` can merge it with `todos` (may appear in serialized agent state).
   */
  todosRequiredSpec?: TodoSequenceSpec,
  historyMessages?: BaseMessage[],
  __interrupt__?: Interrupt<AgentState>[],
};
