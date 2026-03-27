import { tool, type ToolRuntime } from "@langchain/core/tools";
import { GraphInterrupt } from "@langchain/langgraph";
import { AgentState } from "../state.js";
import { REQUEST_HUMAN_APPROVAL_REASON_DESCRIPTION, REQUEST_HUMAN_APPROVAL_TOOL_DESCRIPTION } from "../prompts.js";

/** Tool name for {@link requestHumanInTheLoop}. */
export const REQUEST_HUMAN_APPROVAL_TOOL_NAME = "request_human_approval";

const schema = {
  type: "object" as const,
  properties: {
    reason: {
      type: "string" as const,
      description: REQUEST_HUMAN_APPROVAL_REASON_DESCRIPTION,
    }
  },
  required: ["reason"],
};

/**
 * Human-in-the-loop tool. Calls LangGraph interrupt() so the run pauses; the worker returns the
 * chunk with __interrupt__ and the client can resume with human input. Also returns a marker string
 * so the worker can detect interrupt from stream state when the graph does not emit __interrupt__.
 */
export const requestHumanInTheLoop = tool(
  async (_input, runtime: ToolRuntime<AgentState>) => {
    throw new GraphInterrupt([{ value: runtime.state }]);
  },
  {
    name: REQUEST_HUMAN_APPROVAL_TOOL_NAME,
    description: REQUEST_HUMAN_APPROVAL_TOOL_DESCRIPTION,
    schema,
  }
);
