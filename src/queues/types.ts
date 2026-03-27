import type { AIMessageFields, HumanMessageFields, RemoveMessageFields, SystemMessageFields, ToolMessageFields } from "@langchain/core/messages";
import { AgentState } from "../agent/state.js";

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  /** When status is "completed", the actual result or answer (e.g. the client's full name value). Use empty string when there is no concrete result to store. */
  fulfillment: string;
}

/**
 * `items` are worked in order; `next` runs after every step in `items` is completed — either a single
 * {@link TodoItem} or another graph.
 */
export interface TodoItemsGraph {
  items: (TodoItem | TodoItemsGraph)[];
  next?: TodoItem | TodoItemsGraph;
}

/** Value returned by {@link GetTodosCallback}: a flat or nested ordered spec. */
export type TodoSequenceSpec = (TodoItem | TodoItemsGraph)[];

export function isTodoItemsGraph(node: TodoItem | TodoItemsGraph): node is TodoItemsGraph {
  return (
    typeof node === "object" &&
    node !== null &&
    "items" in node &&
    Array.isArray(node.items)
  );
}

/**
 * Recursively normalizes each node (`TodoItem` or nested `TodoItemsGraph`). Non-array input becomes an
 * empty array; invalid leaf nodes throw.
 */
export function normalizeTodoSequenceSpec(spec: TodoSequenceSpec): TodoSequenceSpec {
  if (!Array.isArray(spec)) return [];
  return spec.map((n) => normalizeTodoSpecNode(n));
}

function normalizeTodoSpecNode(node: TodoItem | TodoItemsGraph): TodoItem | TodoItemsGraph {
  if (typeof node !== "object" || node === null) {
    throw new TypeError("Invalid todo spec node");
  }
  if (isTodoItemsGraph(node) && Array.isArray(node.items)) {
    return {
      items: node.items.map((x) => normalizeTodoSpecNode(x)),
      next: node.next != null ? normalizeTodoSpecNode(node.next) : undefined,
    };
  }
  return node;
}

/**
 * Returns the **current stage** of the spec: skips completed leaves, drops graphs whose inner work is
 * done, and stops before later siblings until the first incomplete item is finished. Then
 * {@link flattenTodoSequence} turns this into a flat list for merging with persisted todos.
 *
 * **Duplicate `content` in `persisted`:** if any row with that `content` is `completed`, the leaf is
 * treated as done (not “last row wins”).
 */
export function resolveTodos(
  nodes: readonly (TodoItem | TodoItemsGraph)[],
  persisted: TodoItem[],
): TodoSequenceSpec {
  const completedContents = new Set(
    persisted.filter((t) => t.status === "completed").map((t) => t.content),
  );
  function isDone(content: string): boolean {
    return completedContents.has(content);
  }

  for (const node of nodes) {
    if (isTodoItemsGraph(node)) {
      if (node.items.length === 0) {
        if (node.next) {
          return resolveTodos([node.next], persisted);
        }
        continue;
      }
      const inner = resolveTodos(node.items, persisted);
      if (inner.length > 0) {
        return [{ items: inner, next: undefined }];
      }
      if (node.next) {
        return resolveTodos([node.next], persisted);
      }
      continue;
    }
    if (!isDone(node.content)) {
      return [node];
    }
  }
  return [];
}

/**
 * Depth-first flatten of a **resolved** or full spec (ignores completion). Duplicate `content` values keep the first occurrence only.
 */
export function flattenTodoSequence(
  nodes: readonly (TodoItem | TodoItemsGraph)[],
  seen: Set<string> = new Set(),
): TodoItem[] {
  const out: TodoItem[] = [];
  for (const n of nodes) {
    if (isTodoItemsGraph(n)) {
      out.push(...flattenTodoSequence(n.items, seen));
      if (n.next) {
        out.push(...flattenTodoSequence([n.next], seen));
      }
    } else if (!seen.has(n.content)) {
      seen.add(n.content);
      out.push(n);
    }
  }
  return out;
}

export interface StoredToolMessage {
  type: "tool";
  data: ToolMessageFields;
}

export interface StoredHumanMessage {
  type: "human";
  data: HumanMessageFields;
}

/** Stored form of an AI message (serializable). */
export interface StoredAIMessage {
  type: "ai";
  data: AIMessageFields;
}

export interface StoredRemoveMessage {
  type: "remove";
  data: RemoveMessageFields;
}

export interface StoredSystemMessage {
  type: "system";
  data: SystemMessageFields;
}

export type StoredMessage = StoredToolMessage | StoredHumanMessage | StoredAIMessage | StoredRemoveMessage | StoredSystemMessage

export interface AgentRunData {
  agentId: string;
  threadId: string;
  /** Contact id (end-user identity). Scopes per-contact memories so personal data never leaks across users. Defaults to threadId when omitted. */
  contactId?: string;
  /** Subagent name; when set, that subagent runs directly (must match a subagent from BullMQAgentWorker options). */
  subagentId?: string;
  /** Optional run-level metadata (e.g. owner, tenant). Passed to configurable for tools and getAgentConfig. */
  metadata?: Record<string, unknown>;
  input: {
    messages: StoredMessage[];
  };
}

/** Agent queue job data for resumeTool: worker builds tool message from last job's AI tool_call_id. */
export interface AgentResumeToolData {
  agentId: string;
  threadId: string;
  /** Contact id (end-user identity). Scopes per-contact memories so personal data never leaks across users. Defaults to threadId when omitted. */
  contactId?: string;
  /** Human response content for the request_human_approval tool. */
  content: string;
  /** Pass when resuming so the same runnable (main or subagent) is used. */
  subagentId?: string;
  /** Optional run-level metadata. */
  metadata?: Record<string, unknown>;
}

/** Agent queue job data (run or resumeTool). Discriminator is job name: "run" | "resumeTool". */
export type AgentJobData = AgentRunData | AgentResumeToolData;

/** One stream state chunk (serializable). When the graph interrupts (e.g. human-in-the-loop), the worker returns the serialized state (messages only); the client detects resume by checking if the last message is an AI message with tool_calls. */
export interface StoredAgentState extends Omit<AgentState, 'messages' | '__interrupt__'> {
  messages: StoredMessage[];
}

/** Job return value: final stream state (messages) and optional interrupt tool payload. */
export type AgentJobResult = StoredAgentState;

export type DocumentSource = { type: 'url' | 'file' | 'text'; content: string; metadata?: Record<string, unknown> }

/**
 * Ingest queue: document ingestion for RAG.
 */
export interface IngestJobData {
  agentId: string;
  source: DocumentSource;
}

/** Result of an ingest job (worker return value). */
export interface IngestJobResult {
  /** Number of source documents ingested. */
  documents: number;
  /** Number of chunks (split documents) added to the vector store. */
  chunks: number;
}

/**
 * Search queue: similarity search over the RAG vector store for an agent.
 */
export interface SearchJobData {
  agentId: string;
  query: string;
  /** Number of results to return (default 5). */
  k?: number;
}

/** Result of a search job (worker return value). */
export interface SearchJobResult {
  results: Array<{ content: string; metadata: Record<string, unknown> }>;
  count: number;
}
