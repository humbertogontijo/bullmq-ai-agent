/**
 * RAG retrieve tool: similarity search over the agent's vector store.
 */

import { Type, type Static } from '@sinclair/typebox';
import type { VectorStore } from '@langchain/core/vectorstores';
import type { AgentTool } from '../types.js';

const RetrieveSchema = Type.Object({
  query: Type.String({ description: 'Search query to find relevant context.' }),
  k: Type.Optional(Type.Number({ description: 'Number of documents to retrieve (optional override).' })),
});

export const DEFAULT_RETRIEVE_TOOL_NAME = 'retrieve';

/**
 * Create the RAG retrieve tool. The handler reads context.ragVectorStore (VectorStore) and context.ragTopK (number).
 */
export function createRetrieveTool(options: {
  name?: string;
  topK: number;
}): AgentTool<typeof RetrieveSchema> {
  const name = options.name ?? DEFAULT_RETRIEVE_TOOL_NAME;
  const topK = options.topK;
  return {
    name,
    description: 'Retrieve relevant context from the agent\'s knowledge base. Use this to look up information before answering.',
    schema: RetrieveSchema,
    handler: async (
      args: Static<typeof RetrieveSchema>,
      context?: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      const store = context?.ragVectorStore as VectorStore | undefined;
      if (!store) {
        return { content: '', error: 'RAG vector store not available.' };
      }
      const k = args.k ?? topK;
      const docs = await store.similaritySearch(args.query, k);
      const content = docs
        .map(
          (d) =>
            `Source: ${(d.metadata?.source as string) ?? 'unknown'}\nContent: ${d.pageContent}`,
        )
        .join('\n\n');
      return { content };
    },
  };
}
