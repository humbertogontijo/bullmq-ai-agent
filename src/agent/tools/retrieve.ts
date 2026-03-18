import { tool } from "@langchain/core/tools";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { RunContext } from "../../options.js";
import type { VectorStoreProviderInterface } from "../../rag/index.js";
import {
  RETRIEVE_K_DESCRIPTION,
  RETRIEVE_QUERY_DESCRIPTION,
  RETRIEVE_TOOL_DESCRIPTION,
} from "../prompts.js";

const schema = {
  type: "object" as const,
  properties: {
    query: {
      type: "string" as const,
      description: RETRIEVE_QUERY_DESCRIPTION,
    },
    k: {
      type: "number" as const,
      description: RETRIEVE_K_DESCRIPTION,
      default: 5,
    },
  },
  required: ["query"],
};

/**
 * Creates the RAG retrieve tool. When getVectorStoreForAgent is provided (e.g. from agent worker),
 * it uses the worker's cached vector stores by agentId. When invoked by the tools worker,
 * the client is passed in args.__documentRedisClient and retrieve is used.
 */
export function createRetrieveTool(
  vectorStoreProvider: VectorStoreProviderInterface
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
      if (!embeddingModelOptions) throw new Error("embeddingModelOptions required for retrieve (pass in run options)");
      const store = await vectorStoreProvider.getVectorStore(agentId, embeddingModelOptions);
      const retrievedDocs = await store.similaritySearch(query, limit);
      const serialized = retrievedDocs
        .map(
          (doc) => `Source: ${doc.metadata.source}\nContent: ${doc.pageContent}`
        )
        .join("\n");
      return [serialized, retrievedDocs];
    },
    {
      name: "retrieve",
      description: RETRIEVE_TOOL_DESCRIPTION,
      schema,
      responseFormat: "content_and_artifact",
    }
  );
}
