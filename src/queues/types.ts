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

function buildCompletedSet(persisted: TodoItem[]): Set<string> {
  return new Set(persisted.filter((t) => t.status === "completed").map((t) => t.content));
}

/**
 * **Sequential siblings** (e.g. {@link TodoItemsGraph.items}): only the first incomplete segment is
 * active; later siblings stay hidden until prior work is done.
 */
function resolveTodosSequential(
  nodes: readonly (TodoItem | TodoItemsGraph)[],
  persisted: TodoItem[],
  completedContents: Set<string>,
): TodoSequenceSpec {
  function isDone(content: string): boolean {
    return completedContents.has(content);
  }

  for (const node of nodes) {
    if (isTodoItemsGraph(node)) {
      if (node.items.length === 0) {
        if (node.next) {
          return resolveTodosSequential([node.next], persisted, completedContents);
        }
        continue;
      }
      const inner = resolveTodosSequential(node.items, persisted, completedContents);
      if (inner.length > 0) {
        return [{ items: inner, next: undefined }];
      }
      if (node.next) {
        return resolveTodosSequential([node.next], persisted, completedContents);
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
 * **Parallel siblings** (top-level {@link TodoSequenceSpec}): each node contributes its current slice,
 * so the result has one segment per still-relevant input node (same length as `nodes` when every node
 * still has work and none are completed graphs-only).
 *
 * **Sequential** `items` inside a {@link TodoItemsGraph} still use {@link resolveTodosSequential}: only
 * the first incomplete step in `items` is active until it is completed.
 *
 * **Duplicate `content` in `persisted`:** if any row with that `content` is `completed`, the leaf is
 * treated as done (not “last row wins”).
 */
export function resolveTodos(
  nodes: readonly (TodoItem | TodoItemsGraph)[],
  persisted: TodoItem[],
): TodoSequenceSpec {
  const completedContents = buildCompletedSet(persisted);
  const out: TodoSequenceSpec = [];

  function isDone(content: string): boolean {
    return completedContents.has(content);
  }

  for (const node of nodes) {
    if (isTodoItemsGraph(node)) {
      if (node.items.length === 0) {
        if (node.next) {
          out.push(...resolveTodos([node.next], persisted));
        }
        continue;
      }
      const inner = resolveTodosSequential(node.items, persisted, completedContents);
      if (inner.length > 0) {
        out.push({ items: inner, next: undefined });
        continue;
      }
      if (node.next) {
        out.push(...resolveTodos([node.next], persisted));
        continue;
      }
      continue;
    }
    if (!isDone(node.content)) {
      out.push(node);
    }
  }
  return out;
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

/**
 * Shared fields for agent queue job payloads ({@link AgentRunData}, {@link AgentResumeToolData}).
 */
export interface AgentJobBaseData {
  agentId: string;
  threadId: string;
  /** Contact id (end-user identity). Scopes per-contact memories so personal data never leaks across users. Defaults to threadId when omitted. */
  contactId?: string;
  /** Subagent name; when set, that subagent runs directly (must match a subagent from BullMQAgentWorker options). */
  subagentId?: string;
  /** Optional run-level metadata (e.g. owner, tenant). Passed to configurable for tools and getAgentConfig. */
  metadata?: Record<string, unknown>;
  /** When "suggest", the AI response is converted into a suggest_response tool call for human review. Use resumeTool to approve/edit. */
  mode?: "auto" | "suggest";
  /**
   * When true, skip the model and only update thread history in Redis.
   * - **run:** store `input.messages` as this job's return value; todos carry forward from the previous job (or `[]`).
   * - **resumeTool:** persist `content` as the final assistant message (after stripping the pending tool-call AI turn); typical for suggest approval.
   */
  persistOnly?: boolean;
}

/**
 * Client options shared by `run` / `resumeTool` / flow builders: same fields as {@link AgentJobBaseData}
 * except `agentId` and `threadId` (those are separate arguments on the client).
 */
export type AgentClientJobBaseOptions = Omit<AgentJobBaseData, "agentId" | "threadId">;

export interface AgentRunData extends AgentJobBaseData {
  input: {
    messages: StoredMessage[];
  };
}

/** Agent queue job data for resumeTool: worker builds tool message from last job's AI tool_call_id. */
export interface AgentResumeToolData extends AgentJobBaseData {
  /** Human response content for the pending tool call. */
  content: string;
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
