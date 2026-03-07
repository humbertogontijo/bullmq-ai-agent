import { BaseMessage } from "@langchain/core/messages";
import { Annotation, Interrupt, messagesStateReducer } from "@langchain/langgraph";
import type { ModelOptions } from "../options.js";
import { OptionalIfUndefined } from "../utils/type.js";

const reducer = <T>(prev: T, next: T) => next !== undefined ? next : prev;

/**
 * Graph state: messages + optional goalId and model options (persisted for resume reuse).
 */
export const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer, default: () => [] }),
  __interrupt__: Annotation<Interrupt[]>(),
  /** Goal id from run/resume; when set, goal's systemPrompt is used. Persisted so resume can omit goal. */
  goalId: Annotation<string | undefined>({ reducer, default: () => undefined }),
  /** Chat model options. Persisted so resume can omit. */
  chatModelOptions: Annotation<ModelOptions>({ reducer, default: () => ({ provider: "openai", model: "gpt-4o", apiKey: "" }) }),
});


export type AgentStateType = OptionalIfUndefined<typeof AgentState.State>
