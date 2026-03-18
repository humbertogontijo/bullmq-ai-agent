/**
 * LangGraph-compatible store interface for cross-thread agent memory.
 *
 * The {@link Item} type and {@link AgentMemoryStore} method signatures mirror
 * `@langchain/langgraph-checkpoint`'s `BaseStore` so that any LangGraph
 * `BaseStore` implementation (e.g. `InMemoryStore`) satisfies this interface
 * via TypeScript structural typing.
 *
 * @see https://langchain-ai.github.io/langgraphjs/reference/classes/langgraph-checkpoint.BaseStore.html
 */

/** Represents a stored item with metadata. Compatible with LangGraph's Item. */
export interface Item {
  /** The stored data as an object. Keys are filterable. */
  value: Record<string, any>;
  /** Unique identifier within the namespace. */
  key: string;
  /** Hierarchical path defining the collection in which this item resides. */
  namespace: string[];
  /** Timestamp of item creation. */
  createdAt: Date;
  /** Timestamp of last update. */
  updatedAt: Date;
}

/** Default limit for {@link AgentMemoryStore.search}. */
export const DEFAULT_SEARCH_LIMIT = 50;

/** First segment of the namespace used for agent memories. */
export const MEMORY_NAMESPACE_PREFIX = "memories";

/** Build the namespace tuple for agent-scoped memories (shared across all contacts). */
export function buildMemoryNamespace(agentId: string): string[] {
  return [MEMORY_NAMESPACE_PREFIX, agentId];
}

/** Build the namespace tuple for contact-scoped memories (private to one user). */
export function buildContactMemoryNamespace(agentId: string, contactId: string): string[] {
  return [MEMORY_NAMESPACE_PREFIX, agentId, "contacts", contactId];
}

/**
 * Abstract store interface for cross-thread agent memory.
 *
 * Method signatures are a subset of LangGraph's `BaseStore`, so any
 * `BaseStore` implementation can be passed directly via structural typing.
 */
export interface AgentMemoryStore {
  /** Store or update an item. */
  put(
    namespace: string[],
    key: string,
    value: Record<string, any>,
  ): Promise<void>;

  /** Retrieve a single item by namespace and key. */
  get(namespace: string[], key: string): Promise<Item | null>;

  /** Search for items within a namespace prefix (newest first). */
  search(
    namespacePrefix: string[],
    options?: {
      filter?: Record<string, any>;
      limit?: number;
      offset?: number;
    },
  ): Promise<Item[]>;

  /** Delete an item from the store. */
  delete(namespace: string[], key: string): Promise<void>;
}
