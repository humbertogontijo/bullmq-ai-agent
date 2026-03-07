/**
 * Load document content from URL, file path, or text using LangChain document loaders.
 * @see https://docs.langchain.com/oss/javascript/integrations/document_loaders
 */

import { TextLoader } from '@langchain/classic/document_loaders/fs/text';
import { CheerioWebBaseLoader } from '@langchain/community/document_loaders/web/cheerio';
import { Document } from '@langchain/core/documents';
import { DocumentSource } from '../queues/types.js';

/**
 * Load one or more Document(s) from a DocumentSource using LangChain document loaders.
 * - url: CheerioWebBaseLoader (web loaders)
 * - file: TextLoader (file loaders)
 * - text: inline Document
 */
export async function loadDocumentsFromSource(
  source: DocumentSource,
): Promise<Document[]> {
  switch (source.type) {
    case 'url': {
      const loader = new CheerioWebBaseLoader(source.content);
      const docs = await loader.load();
      const extra = source.metadata ?? {};
      return docs.map((doc) =>
        new Document({
          pageContent: doc.pageContent,
          metadata: { ...doc.metadata, source: source.content, ...extra },
        }),
      );
    }
    case 'file': {
      const loader = new TextLoader(source.content);
      const docs = await loader.load();
      const extra = source.metadata ?? {};
      return docs.map((doc) =>
        new Document({
          pageContent: doc.pageContent,
          metadata: { ...doc.metadata, source: source.content, ...extra },
        }),
      );
    }
    case 'text': {
      const metadata = { source: 'inline', ...(source.metadata ?? {}) };
      return [new Document({ pageContent: source.content, metadata })];
    }
    default: {
      throw new Error(`Unknown document source type: ${source.type}`);
    }
  }
}
