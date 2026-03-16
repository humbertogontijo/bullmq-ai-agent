/**
 * Sortable unique ID generator (snowflake-like).
 * IDs are numeric strings that sort lexicographically in creation order.
 */

const EPOCH = 1609459200000; // 2021-01-01 UTC
let sequence = 0;

/**
 * Returns a new sortable unique ID as a string.
 * Safe for use as BullMQ job IDs (no colons).
 */
export function snowflake(): string {
  const now = Date.now() - EPOCH;
  const id = (BigInt(now) << 22n) | (BigInt(sequence++) & 0xfffn);
  if (sequence >= 4096) sequence = 0;
  return id.toString();
}
