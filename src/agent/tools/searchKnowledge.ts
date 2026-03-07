import { tool } from "@langchain/core/tools";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { z } from "zod";
import type { RunContext } from "../../options.js";
import type { VectorStoreProvider } from "../../rag/index.js";

const schema = z.object({
  query: z.string().describe("Search query for the knowledge base"),
  k: z.number().optional().default(5).describe("Number of results to return"),
});

/**
 * Creates the RAG search tool. When getVectorStoreForAgent is provided (e.g. from agent worker),
 * it uses the worker's cached vector stores by agentId. When invoked by the tools worker,
 * the client is passed in args.__documentRedisClient and searchKnowledge is used.
 */
export function createSearchKnowledgeTool(
  vectorStoreProvider: VectorStoreProvider
) {
  return tool(
    async (args: {
      query: string;
      k?: number;
    }, runnableConfig: LangGraphRunnableConfig
    ) => {
      if (!runnableConfig) return {};
      const configurable = runnableConfig.configurable as RunContext;
      const agentId = configurable.agentId;
      const embeddingModelOptions = configurable.embeddingModelOptions;
      const { query, k } = args;
      const limit = k ?? 5;
      if (!embeddingModelOptions) throw new Error("embeddingModelOptions required for search_knowledge (pass in run options)");
      try {
        const store = await vectorStoreProvider.getVectorStore(`${agentId}-rag`, embeddingModelOptions);
        const docs = await store.similaritySearch(query, limit);
        const results = docs.map((d) => ({
          content: d.pageContent,
          metadata: d.metadata as Record<string, unknown>,
        }));
        return JSON.stringify({ results, count: results.length });
      } catch {
        return JSON.stringify({ message: "RAG not configured", query, k: limit });
      }
    },
    {
      name: "search_knowledge",
      description: "Search the knowledge base (RAG) for relevant documents.",
      schema,
    }
  );
}
