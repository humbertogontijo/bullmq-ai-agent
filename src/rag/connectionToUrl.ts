/**
 * Build a redis URL for node-redis from BullMQ/IORedis ConnectionOptions.
 * When connection is a Redis/IORedis instance, reads from instance.options only (no clone of config).
 */

import type { ConnectionOptions } from 'bullmq';

/** True when connection is an IORedis Redis or Cluster instance (has .options), not a plain config object. */
function isRedisInstance(
  c: ConnectionOptions,
): c is ConnectionOptions & { options: Record<string, unknown> } {
  return (
    c != null &&
    typeof c === 'object' &&
    'options' in c &&
    (c as { options?: unknown }).options != null &&
    typeof (c as { options: unknown }).options === 'object'
  );
}

function buildUrlFromOptions(opts: Record<string, unknown>): string {
  if (typeof opts.url === 'string') return opts.url;
  const host = (opts.host as string) ?? 'localhost';
  const port = (opts.port as number) ?? 6379;
  const password = opts.password as string | undefined;
  const db = opts.db as number | undefined;
  let url = `redis://${host}:${port}`;
  if (password) url = url.replace('redis://', `redis://:${encodeURIComponent(password)}@`);
  if (db !== undefined && db !== 0) url += `/${db}`;
  return url;
}

export function connectionToRedisUrl(connection: ConnectionOptions): string {
  const opts: Record<string, unknown> = isRedisInstance(connection)
    ? (connection.options as Record<string, unknown>)
    : (connection as Record<string, unknown>);
  return buildUrlFromOptions(opts);
}
