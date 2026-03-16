import { tool, type ToolRuntime } from "@langchain/core/tools";
import { GraphInterrupt } from "@langchain/langgraph";
import { AgentState } from "../state.js";
import { ESCALATE_TO_HUMAN_REASON_DESCRIPTION, ESCALATE_TO_HUMAN_TOOL_DESCRIPTION } from "../prompts.js";

const schema = {
  type: "object" as const,
  properties: {
    reason: {
      type: "string" as const,
      description: ESCALATE_TO_HUMAN_REASON_DESCRIPTION,
    }
  },
  required: ["reason"],
};

/**
 * Tool that fully hands off the conversation to a human. When the model calls this,
 * the client can route to a human (no resume). Use request_human_approval when you need
 * hints/approval and want the agent to continue.
 */
export const escalateToHuman = tool(
  async (_input, runtime: ToolRuntime<AgentState>) => {
    throw new GraphInterrupt([{ value: runtime.state }]);
  },
  {
    name: "escalate_to_human",
    description: ESCALATE_TO_HUMAN_TOOL_DESCRIPTION,
    schema,
  }
);
