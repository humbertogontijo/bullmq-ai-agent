import { tool } from "@langchain/core/tools";
import { interrupt } from "@langchain/langgraph";

const schema = {
  type: "object" as const,
  properties: {
    reason: {
      type: "string" as const,
      description: "Reason for escalating to a human (e.g. complex request, complaint, out-of-scope).",
    },
    context: {
      type: "object" as const,
      description: "Optional context to pass to the human (e.g. summary, customer info).",
    },
  },
  required: ["reason"],
};

/**
 * Tool that fully hands off the conversation to a human. When the model calls this,
 * the run completes with status "escalated" and the client can route to a human (no resume).
 * Use request_human_approval when you need hints/approval and want the agent to continue.
 */
export const escalateToHuman = tool(
  async ({ reason, context }) => {
    return interrupt({
      type: "escalate",
      reason: String(reason ?? "Escalation requested"),
      context: (context as Record<string, unknown>) ?? {},
    });
  },
  {
    name: "escalate_to_human",
    description:
      "Fully hand off this conversation to a human agent. Use when the customer needs human support (e.g. complaint, complex issue, out-of-scope). Do not use for simple approval—use request_human_approval instead.",
    schema,
  }
);
