/**
 * Centralized BullMQ queue key layout. BullMQ stores job keys as {prefix}:{queueName}:{jobId}.
 * JobId for agent runs is threadId/<snowflake>. Use these helpers so only one place defines the pattern.
 */

/** Default prefix when not provided (matches BullMQ default). */
export const DEFAULT_QUEUE_PREFIX = "bull";

/**
 * Resolve the queue key prefix. Use this when passing to BullMQ options or to key helpers.
 * Keeps the prefix option; centralization is only where the pattern is built.
 */
export function getQueueKeyPrefix(prefix?: string): string {
  return prefix ?? DEFAULT_QUEUE_PREFIX;
}

/**
 * Prefix for job keys in Redis: "{queueKeyPrefix}:{queueName}:".
 * Used to build scan patterns and to strip the prefix from key strings to get jobId.
 */
export function buildJobIdPrefix(queueKeyPrefix: string, queueName: string): string {
  return `${queueKeyPrefix}:${queueName}:`;
}

/**
 * Redis SCAN pattern for all job keys in a thread: "{jobIdPrefix}{threadId}/*".
 * JobIds are expected to be threadId/<snowflake>.
 */
export function buildThreadScanPattern(
  queueKeyPrefix: string,
  queueName: string,
  threadId: string
): string {
  const jobIdPrefix = buildJobIdPrefix(queueKeyPrefix, queueName);
  return `${jobIdPrefix}${threadId}/*`;
}

/**
 * Redis key for the sorted set of job IDs per thread (score = snowflake id, value = jobId).
 * Used to fetch the last executed job for resumeTool and to load thread history. Keyed by threadId only.
 * Format: "{prefix}:{queueName}:thread-jobs:{threadId}".
 */
export function buildThreadJobsKey(
  queueKeyPrefix: string,
  queueName: string,
  threadId: string
): string {
  const base = buildJobIdPrefix(queueKeyPrefix, queueName);
  return `${base}thread-jobs:${threadId}`;
}

/**
 * Redis key for the BullMQ completed set (sorted set of completed job IDs).
 * Format: "{prefix}:{queueName}:completed".
 */
export function buildCompletedKey(queueKeyPrefix: string, queueName: string): string {
  const base = buildJobIdPrefix(queueKeyPrefix, queueName);
  return `${base}completed`;
}

