/**
 * Document loader that loads documents from a text file or Blob.
 * Adapted from @langchain/classic TextLoader to avoid the dependency.
 */

import { readFile } from 'node:fs/promises';
import { Document } from '@langchain/core/documents';
import { BaseDocumentLoader } from '@langchain/core/document_loaders/base';

/**
 * A class that extends the `BaseDocumentLoader` class. It represents a
 * document loader that loads documents from a text file. The `load()`
 * method reads the text from the file or blob, parse it using the `parse()`
 * method, and creates a `Document` instance for each parsed page. The metadata
 * includes the source of the text (file path or blob) and, if there are
 * multiple pages, the line number of each page.
 */
export class TextLoader extends BaseDocumentLoader {
  filePathOrBlob: string | Blob;

  constructor(filePathOrBlob: string | Blob) {
    super();
    this.filePathOrBlob = filePathOrBlob;
  }

  /**
   * A protected method that takes a `raw` string as a parameter and returns
   * a promise that resolves to an array containing the raw text as a single element.
   */
  protected async parse(raw: string): Promise<string[]> {
    return [raw];
  }

  /**
   * Loads the text file or blob and returns a promise that resolves to an
   * array of `Document` instances.
   */
  async load(): Promise<Document[]> {
    let text: string;
    let metadata: Record<string, unknown>;

    if (typeof this.filePathOrBlob === 'string') {
      text = await readFile(this.filePathOrBlob, 'utf8');
      metadata = { source: this.filePathOrBlob };
    } else {
      text = await this.filePathOrBlob.text();
      metadata = {
        source: 'blob',
        blobType: this.filePathOrBlob.type,
      };
    }

    const parsed = await this.parse(text);
    parsed.forEach((pageContent, i) => {
      if (typeof pageContent !== 'string') {
        throw new Error(
          `Expected string, at position ${i} got ${typeof pageContent}`,
        );
      }
    });

    return parsed.map((pageContent, i) =>
      new Document({
        pageContent,
        metadata:
          parsed.length === 1
            ? metadata
            : { ...metadata, line: i + 1 },
      }),
    );
  }
}
