import { RemoveMessage } from "@langchain/core/messages";
import type { Redis } from "ioredis";
import { createMiddleware } from "langchain";
import { z } from "zod";

import { getPreviousReturnvaluesScript } from "../../commands/index.js";
import { QUEUE_NAMES, runContextContextSchema, type RunContext } from "../../options.js";
import { buildJobIdPrefix, buildThreadJobsKey } from "../../queues/queueKeys.js";
import type { AgentJobResult, StoredAgentState, StoredMessage } from "../../queues/types.js";
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

/**
 * Load only thread history messages from previous jobs' return values (no input messages).
 * Uses the thread-jobs sorted set (ZRANGEBYSCORE), keyed by threadId only. Used by history middleware in beforeAgent.
 * When maxJobs is set, the Lua script returns at most that many previous jobs; otherwise DEFAULT_MAX_HISTORY_JOBS.
 */
export async function getThreadHistoryMessages(
  redis: RedisWithEval,
  threadId: string,
  currentJobId: string,
  queueKeyPrefix: string,
  maxJobs?: number,
): Promise<StoredMessage[]> {
  const currentTs = parseTimestampFromJobId(currentJobId);
  if (Number.isNaN(currentTs)) {
    return [];
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
  for (const s of raw ?? []) {
    if (!s || s === "") continue;
    try {
      const rv = JSON.parse(s) as AgentJobResult | undefined;
      if (!rv?.messages || !Array.isArray(rv.messages)) continue;
      historyMessages.push(...rv.messages);
    } catch {
      // skip malformed returnvalue
    }
  }
  return historyMessages;
}

/** Serialize one stream state chunk to JSON-safe StoredAgentState (messages only). */
export function serializeAgentState(state: AgentState): StoredAgentState {
  if (state.__interrupt__ != null && Array.isArray(state.__interrupt__) && state.__interrupt__.length > 0) {
    const [first] = state.__interrupt__;
    const value = first?.value as AgentState | undefined;
    if (value) return serializeAgentState(value);
  }
  const messages = state.messages ?? [];
  const stored = mapChatMessagesToStoredMessages(messages);
  return { messages: stored };
}

/**
 * Creates an agent middleware that loads thread history in beforeAgent, injects it only
 * in wrapModelCall (so the model sees full context), and clears it in afterAgent.
 * State.messages is never merged with history, so tool/tool_calls ordering stays valid
 * and we avoid "messages with role 'tool' must be a response to a preceding message with 'tool_calls'".
 * Job return value is only new messages (delta) since state.messages is never prepended with history.
 * Expects run context (redis, thread_id, job, queueKeyPrefix) via config.context at invoke time.
 */
export function createHistoryMiddleware() {
  return createMiddleware({
    name: "HistoryMiddleware",
    stateSchema: z.object({
      /** History messages from previous jobs; only injected at model call time, not merged into state.messages. */
      historyMessages: z.array(z.any()).optional(),
    }),
    contextSchema: runContextContextSchema,
    beforeAgent: async (state, runtime) => {
      const ctx = runtime?.context as RunContext | undefined;
      const { redis, thread_id, job, queueKeyPrefix } = ctx ?? {};
      if (!redis || !job?.id || !queueKeyPrefix || !thread_id) {
        return;
      }

      const maxJobs = typeof ctx?.maxHistoryMessages === "number" && ctx.maxHistoryMessages > 0
        ? ctx.maxHistoryMessages
        : undefined;
      const stored = await getThreadHistoryMessages(
        redis,
        thread_id,
        job.id,
        queueKeyPrefix,
        maxJobs,
      );
      const historyMessages = mapStoredMessagesToChatMessages(stored);
      return { historyMessages };
    },
    wrapModelCall: async (request, handler) => {
      const history = request.state?.historyMessages ?? [];
      const messages = request.messages ?? [];
      return handler({
        ...request,
        messages: [...history, ...messages],
      });
    },
    afterAgent: (state) => {
      const historyMessages = state?.historyMessages ?? [];
      const messages = state?.messages ?? [];
      if (historyMessages.length > 0) {
        const delta = messages.filter(message => !historyMessages.find(h => h.id != undefined && h.id === message.id));
        return {
          messages: [
            new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
            ...delta,
          ],
          historyMessages: [],
        };
      }
      return { historyMessages: [] };
    },
  });
}
