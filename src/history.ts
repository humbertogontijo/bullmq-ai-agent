import type { Queue } from 'bullmq';
import type {
  AgentChildResult,
  ToolCall,
  SerializedMessage,
  StepResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Redis-level helpers: ZSCAN discovery + pipelined HGET
// ---------------------------------------------------------------------------

/**
 * ZSCAN BullMQ's completed sorted set to discover all job IDs for a session.
 * Returns job IDs sorted chronologically by completion score.
 */
export async function discoverSessionJobs(
  queue: Queue,
  sessionId: string,
): Promise<string[]> {
  const client = await queue.client;
  const completedKey = queue.toKey('completed');
  const pattern = `${sessionId}/*`;

  const jobs: { id: string; score: number }[] = [];
  let cursor = '0';

  do {
    const [next, items]: [string, string[]] = await client.zscan(
      completedKey,
      cursor,
      'MATCH',
      pattern,
      'COUNT',
      200,
    );
    cursor = next;
    for (let i = 0; i < items.length; i += 2) {
      jobs.push({ id: items[i], score: parseFloat(items[i + 1]) });
    }
  } while (cursor !== '0');

  jobs.sort((a, b) => a.score - b.score);
  return jobs.map((j) => j.id);
}

/**
 * Discover all completed session jobs via ZSCAN, then batch-fetch their
 * `returnvalue` fields in a single Redis pipeline.
 * Results are sorted chronologically (oldest first).
 */
export async function fetchSessionResults(
  queue: Queue,
  sessionId: string,
): Promise<StepResult[]> {
  const pairs = await fetchResultsWithIds(queue, sessionId);
  return pairs.map(([, result]) => result);
}

/**
 * Find the most recent non-routing StepResult across both queues.
 * Used by the orchestrator to retrieve the previous interaction's state.
 */
export async function findLatestResult(
  orchQueue: Queue,
  aggQueue: Queue,
  sessionId: string,
): Promise<StepResult | null> {
  const [orchPairs, aggPairs] = await Promise.all([
    fetchResultsWithIds(orchQueue, sessionId),
    fetchResultsWithIds(aggQueue, sessionId),
  ]);

  const all = [...orchPairs, ...aggPairs].sort(
    (a, b) => extractTimestamp(a[0]) - extractTimestamp(b[0]),
  );

  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i][1].status !== 'routing') return all[i][1];
  }

  return null;
}

// ---------------------------------------------------------------------------
// Internal: ZSCAN + pipelined HGET returning [jobId, StepResult] pairs
// ---------------------------------------------------------------------------

async function fetchResultsWithIds(
  queue: Queue,
  sessionId: string,
): Promise<[string, StepResult][]> {
  const jobIds = await discoverSessionJobs(queue, sessionId);
  if (!jobIds.length) return [];

  const client = await queue.client;
  const pipeline = client.pipeline();
  for (const id of jobIds) {
    pipeline.hget(queue.toKey(id), 'returnvalue');
  }
  const raw = await pipeline.exec();
  if (!raw) return [];

  const results: [string, StepResult][] = [];
  for (let i = 0; i < raw.length; i++) {
    const [err, val] = raw[i];
    if (err || !val) continue;
    try {
      const parsed =
        typeof val === 'string' ? JSON.parse(val as string) : val;
      results.push([jobIds[i], parsed as StepResult]);
    } catch {
      // skip unparseable return values
    }
  }
  return results;
}

function extractTimestamp(jobId: string): number {
  const slash = jobId.lastIndexOf('/');
  return slash >= 0 ? parseInt(jobId.slice(slash + 1), 10) : 0;
}

// ---------------------------------------------------------------------------
// History extraction from StepResult arrays
// ---------------------------------------------------------------------------

/**
 * Extract single-goal history deltas from orchestrator results.
 * Used by the worker to reconstruct LLM context in single-goal mode.
 */
export function extractSingleGoalHistory(
  orchResults: StepResult[],
): SerializedMessage[] {
  const messages: SerializedMessage[] = [];
  for (const result of orchResults) {
    if (result?.history?.length) {
      messages.push(...result.history);
    }
  }
  return messages;
}

/**
 * Extract per-agent message deltas from aggregator results.
 * Used by the agent worker to reconstruct per-agent LLM context.
 */
export function extractAgentMessages(
  aggResults: StepResult[],
  goalId: string,
): SerializedMessage[] {
  const messages: SerializedMessage[] = [];
  for (const result of aggResults) {
    const delta = result?.agentResults?.[goalId]?.messages;
    if (delta?.length) {
      messages.push(...delta);
    }
  }
  return messages;
}

/**
 * Reconstruct the full conversation from both orchestrator and aggregator results.
 * Works for both single-goal and multi-goal modes:
 *
 * - Orchestrator results provide user prompts (routing) and single-goal deltas.
 * - Aggregator results provide per-agent conversation deltas (including tool
 *   calls and responses) from `agentResults[goalId].messages`.
 *
 * In multi-goal mode, human messages from per-agent deltas are omitted since
 * the user prompt is already included from the orchestrator routing result.
 */
export function buildConversationHistory(
  orchResults: StepResult[],
  aggResults: StepResult[],
): SerializedMessage[] {
  const len = Math.max(orchResults.length, aggResults.length);
  const messages: SerializedMessage[] = [];

  for (let i = 0; i < len; i++) {
    const orch = i < orchResults.length ? orchResults[i] : null;
    const agg = i < aggResults.length ? aggResults[i] : null;

    if (orch?.history?.length) {
      messages.push(...orch.history);
    }

    if (agg?.agentResults) {
      for (const result of Object.values(agg.agentResults)) {
        if (!result.messages?.length) continue;
        for (const m of result.messages) {
          if (m.role !== 'human') {
            messages.push(m);
          }
        }
      }
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Derivation helpers — extract data from messages to avoid storing it twice
// ---------------------------------------------------------------------------

/** Derive the text response from the last AI message with content. */
export function deriveResponse(
  messages: SerializedMessage[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'ai' && messages[i].content) {
      return messages[i].content;
    }
  }
  return undefined;
}

/** Derive tool calls from the last AI message that has toolCalls. */
export function deriveToolCalls(
  messages: SerializedMessage[],
  goalId: string,
): ToolCall[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'ai' && m.toolCalls?.length) {
      return m.toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        args: tc.args,
        goalId,
      }));
    }
  }
  return [];
}

/** Build routing context from agentResults (replaces mergeAgentHistories). */
export function deriveRoutingHistory(
  agentResults: Record<string, AgentChildResult>,
): SerializedMessage[] {
  const merged: SerializedMessage[] = [];
  for (const [goalId, result] of Object.entries(agentResults)) {
    const response = deriveResponse(result.messages);
    if (response) {
      merged.push({ role: 'ai', content: `[${goalId}] ${response}` });
    }
  }
  return merged;
}
