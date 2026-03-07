import { tool } from "@langchain/core/tools";
import { interrupt } from "@langchain/langgraph";
import { z } from "zod";

const schema = z.object({
    message: z.string().describe("Question or message to show the human"),
    options: z.record(z.unknown()).optional().describe("Optional structured options"),
});

/**
 * RAG search tool. Uses Redis vector store when available (see registerDefaultTools).
 */
export const requestHumanInTheLoop = tool(
    async ({ message, options }) => {
      return interrupt({
        type: "human",
        message: String(message ?? "Approve or provide input."),
        options: (options as Record<string, unknown>) ?? {},
      });
    },
    {
      name: "request_human_approval",
      description: "Pause and ask a human for approval or input. Pass message and optional options.",
      schema,
    }
  );
