import { tool } from "@langchain/core/tools";
import { interrupt } from "@langchain/langgraph";
import { HumanInterruptPayload } from "../../queues/types.js";

const schema = {
  type: "object" as const,
  properties: {
    reason: {
      type: "string" as const,
      description: "Question or message to show the human",
    },
    context: {
      type: "object" as const,
      description: "Optional structured context",
    },
  },
  required: ["reason"],
};

/**
 * RAG search tool. Uses Redis vector store when available (see registerDefaultTools).
 */
export const requestHumanInTheLoop = tool(
  async ({ reason, context }) => {
    return interrupt({
      type: "human",
      reason: String(reason ?? "Approve or provide input."),
      context: (context as Record<string, unknown>) ?? {},
    } satisfies HumanInterruptPayload);
  },
  {
    name: "request_human_approval",
    description: "Pause and ask a human for approval or input. Pass message and optional options.",
    schema,
  }
);
