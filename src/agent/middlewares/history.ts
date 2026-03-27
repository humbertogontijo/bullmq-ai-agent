import { RemoveMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import type { Redis } from "ioredis";
import { createMiddleware } from "langchain";
import { z } from "zod";

import { getPreviousReturnvaluesScript } from "../../commands/index.js";
import { QUEUE_NAMES, runContextContextSchema, type RunContext } from "../../options.js";
import { buildJobIdPrefix, buildThreadJobsKey } from "../../queues/queueKeys.js";
import type { AgentJobResult, StoredAgentState, StoredMessage, TodoItem } from "../../queues/types.js";
import { mapChatMessagesToStoredMessages, mapStoredMessagesToChatMessages, REMOVE_ALL_MESSAGES } from "../../utils/messageMapping.js";
import { AgentState } from "../state.js";

/**
 * Parse sort key from jobId of the form "threadId/<snowflake>".
 * Returns NaN if format is invalid.
 */
export function parseTimestampFromJobId(jobId: string): number {
  const lastSlash = jobId.lastIndexOf("/");
  if (lastSlash === -1) return NaN;
  const ts = jobId.slice(lastSlash + 1);
  return parseInt(ts, 10);
}

/** Default max number of previous jobs to load when maxHistoryMessages is not set. */
export const DEFAULT_MAX_HISTORY_JOBS = 500;

/** Minimal Redis interface for loading thread history. Allows mocks in tests. */
export type RedisWithEval = Pick<Redis, "eval">;

/** Thread history loaded from previous jobs' return values. */
export interface ThreadHistoryData {
  messages: StoredMessage[];
  /** Todos from the most recent previous job (empty when no prior job has todos). */
  todos: TodoItem[];
}

/**
 * Load thread history from previous jobs' return values.
 * Returns accumulated messages from all previous jobs and todos from the most
 * recent job (since todos are replaced wholesale each run).
 * Uses the thread-jobs sorted set (ZRANGEBYSCORE), keyed by threadId only.
 * When maxJobs is set, the Lua script returns at most that many previous jobs;
 * otherwise DEFAULT_MAX_HISTORY_JOBS.
 */
export async function getThreadHistory(
  redis: RedisWithEval,
  threadId: string,
  currentJobId: string,
  queueKeyPrefix: string,
  maxJobs?: number,
): Promise<ThreadHistoryData> {
  const currentTs = parseTimestampFromJobId(currentJobId);
  if (Number.isNaN(currentTs)) {
    return { messages: [], todos: [] };
  }
  const jobIdPrefix = buildJobIdPrefix(queueKeyPrefix, QUEUE_NAMES.AGENT);
  const threadJobsKey = buildThreadJobsKey(queueKeyPrefix, QUEUE_NAMES.AGENT, threadId);
  const limit = typeof maxJobs === "number" && maxJobs > 0 ? maxJobs : DEFAULT_MAX_HISTORY_JOBS;
  const raw = (await redis.eval(
    getPreviousReturnvaluesScript,
    1,
    threadJobsKey,
    String(currentTs),
    jobIdPrefix,
    String(limit)
  )) as (string | null)[];
  const historyMessages: StoredMessage[] = [];
  let lastTodos: TodoItem[] = [];
  for (const s of raw ?? []) {
    if (!s || s === "") continue;
    try {
      const rv = JSON.parse(s) as AgentJobResult | undefined;
      if (!rv) continue;
      if (rv.messages && Array.isArray(rv.messages)) {
        historyMessages.push(...rv.messages);
      }
      if (rv.todos && Array.isArray(rv.todos)) {
        lastTodos = rv.todos;
      }
    } catch {
      // skip malformed returnvalue
    }
  }
  return { messages: historyMessages, todos: lastTodos };
}


/** Serialize one stream state chunk to JSON-safe StoredAgentState. */
export function serializeAgentState(state: AgentState): StoredAgentState {
  if (state.__interrupt__ != null && Array.isArray(state.__interrupt__) && state.__interrupt__.length > 0) {
    const [first] = state.__interrupt__;
    const value = first?.value;
    if (value) return serializeAgentState(value);
  }
  const messages = state.messages ?? [];
  const stored = mapChatMessagesToStoredMessages(messages);
  return { messages: stored, todos: state.todos };
}

/**
 * Creates an agent middleware that manages thread history across jobs.
 *
 * - beforeAgent: loads history from Redis and stores it in graph state as historyMessages.
 * - beforeModel: injects history into state.messages (system messages first, then history,
 *   then current messages) so the model sees full conversation context.
 * - afterModel: removes the injected history messages from state.messages via RemoveMessage
 *   so they don't persist in the graph state or the job's return value.
 *
 * The stateSchema exposes historyMessages so downstream middlewares
 * (e.g. SummarizationMiddleware) can read it from graph state in their beforeAgent hook.
 *
 * Expects run context (redis, thread_id, job, queueKeyPrefix) via config.context at invoke time.
 */
export function createHistoryMiddleware() {
  return createMiddleware({
    name: "HistoryMiddleware",
    stateSchema: z.object({
      historyMessages: z.array(z.any()).optional(),
      todos: z.array(z.object({
        content: z.string(),
        status: z.enum(["pending", "in_progress", "completed"]),
        fulfillment: z.string(),
      })).default([]),
    }),
    contextSchema: runContextContextSchema,
    beforeAgent: async (_state, runtime) => {
      const ctx = runtime?.context;
      const { redis, thread_id, job, queueKeyPrefix } = ctx ?? {};
      if (!redis || !job?.id || !queueKeyPrefix || !thread_id) {
        return;
      }

      const maxJobs = typeof ctx?.maxHistoryMessages === "number" && ctx.maxHistoryMessages > 0
        ? ctx.maxHistoryMessages
        : undefined;
      const { messages: stored, todos } = await getThreadHistory(
        redis,
        thread_id,
        job.id,
        queueKeyPrefix,
        maxJobs,
      );
      const historyMessages = mapStoredMessagesToChatMessages(stored);
      return { historyMessages, todos };
    },
    beforeModel: async (state) => {
      const historyMessages = state?.historyMessages ?? [];
      const systemMessages = (state?.messages ?? []).filter(message => SystemMessage.isInstance(message));
      const messages = (state?.messages ?? []).filter(message => !SystemMessage.isInstance(message));
      return {
        messages: [
          new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
          ...systemMessages,
          ...historyMessages,
          ...messages,
        ]
      }
    },
    afterModel: (state) => {
      const historyMessages = state?.historyMessages ?? [];
      return {
        messages: historyMessages.map(message => new RemoveMessage({ id: message.id })),
      };
    },
  });
}
