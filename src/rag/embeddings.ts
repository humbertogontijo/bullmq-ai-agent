import { CohereEmbeddings } from '@langchain/cohere';
import { OpenAIEmbeddings } from '@langchain/openai';

/**
 * Embedding factory for RAG. Uses optional peer deps (@langchain/openai, @langchain/cohere).
 */

import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import type { EmbeddingConfig } from '../types.js';

export function getEmbeddings(config: EmbeddingConfig): EmbeddingsInterface {
  switch (config.provider) {
    case 'openai': {
      return new OpenAIEmbeddings({
        model: config.model ?? 'text-embedding-3-small',
        openAIApiKey: config.apiKey ?? process.env.OPENAI_API_KEY,
      });
    }
    case 'cohere': {
      return new CohereEmbeddings({
        model: config.model ?? 'embed-english-v3.0',
        apiKey: config.apiKey ?? process.env.COHERE_API_KEY,
      });
    }
    default: {
      const p = (config as EmbeddingConfig).provider;
      throw new Error(`Unknown embedding provider: ${p}`);
    }
  }
}
