/**
 * Split documents into chunks. Uses simple chunking; optional @langchain/textsplitters can be used by callers.
 */

import { Document } from '@langchain/core/documents';

const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_CHUNK_OVERLAP = 200;

/**
 * Split documents into chunks (simple length-based). For RecursiveCharacterTextSplitter, use @langchain/textsplitters in your app.
 */
export async function splitDocuments(
  documents: Document[],
  options: { chunkSize?: number; chunkOverlap?: number } = {},
): Promise<Document[]> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap = options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
  const out: Document[] = [];
  for (const doc of documents) {
    const text = doc.pageContent;
    for (let i = 0; i < text.length; i += chunkSize - chunkOverlap) {
      const chunk = text.slice(i, i + chunkSize);
      if (chunk.trim()) {
        out.push(new Document({ pageContent: chunk, metadata: { ...doc.metadata } }));
      }
    }
  }
  return out;
}
