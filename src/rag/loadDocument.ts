/**
 * Load document content from URL, file path, or text. Used by addDocument.
 */

import { readFile } from 'fs/promises';
import { Document } from '@langchain/core/documents';
import type { DocumentSource } from '../types.js';

async function loadFromUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const html = await res.text();
  // Strip HTML tags for plain text (simple approach; could use Cheerio for better extraction)
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text || html;
}

async function loadFromFile(path: string): Promise<string> {
  const buf = await readFile(path, 'utf-8');
  return buf;
}

/**
 * Load one or more Document(s) from a DocumentSource.
 */
export async function loadDocumentsFromSource(
  source: DocumentSource,
): Promise<Document[]> {
  let pageContent: string;
  let metadata: Record<string, unknown> = {};

  switch (source.type) {
    case 'url':
      pageContent = await loadFromUrl(source.url);
      metadata = { source: source.url, ...source.metadata };
      break;
    case 'file':
      pageContent = await loadFromFile(source.path);
      metadata = { source: source.path, ...source.metadata };
      break;
    case 'text':
      pageContent = source.text;
      metadata = source.metadata ?? {};
      break;
    default:
      throw new Error(`Unknown document source type: ${(source as DocumentSource).type}`);
  }

  return [new Document({ pageContent, metadata })];
}
