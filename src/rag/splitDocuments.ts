/**
 * Split documents into chunks using RecursiveCharacterTextSplitter from @langchain/textsplitters.
 */

import { Document } from '@langchain/core/documents';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';

const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_CHUNK_OVERLAP = 200;

/**
 * Split documents into chunks using RecursiveCharacterTextSplitter.
 * Splits recursively by paragraph, line, then space to keep semantic coherence.
 */
export async function splitDocuments(
  documents: Document[],
  options: { chunkSize?: number; chunkOverlap?: number } = {},
): Promise<Document[]> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap = options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
  });
  return splitter.splitDocuments(documents);
}
