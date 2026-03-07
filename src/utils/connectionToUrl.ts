/**
 * Build a redis URL for node-redis from BullMQ/IORedis ConnectionOptions.
 * When connection is a Redis/IORedis instance, reads from instance.options only (no clone of config).
 */

import type { ConnectionOptions } from 'bullmq';

/** Options we read to build a Redis URL (from ConnectionOptions or connection.options). */
export interface RedisUrlOptions {
  url?: string;
  host?: string;
  port?: number;
  password?: string;
  db?: number;
}

/** True when connection is an IORedis Redis or Cluster instance (has .options), not a plain config object. */
function isRedisInstance(
  c: ConnectionOptions,
): c is ConnectionOptions & { options: RedisUrlOptions } {
  return (
    c != null &&
    typeof c === 'object' &&
    'options' in c &&
    c.options != null &&
    typeof c.options === 'object'
  );
}

function buildUrlFromOptions(opts: RedisUrlOptions): string {
  if (typeof opts.url === 'string') return opts.url;
  const host = opts.host ?? 'localhost';
  const port = opts.port ?? 6379;
  const password = opts.password;
  const db = opts.db;
  let url = `redis://${host}:${port}`;
  if (password) url = url.replace('redis://', `redis://:${encodeURIComponent(password)}@`);
  if (db !== undefined && db !== 0) url += `/${db}`;
  return url;
}

export function connectionToRedisUrl(connection: ConnectionOptions): string {
  const opts: RedisUrlOptions = isRedisInstance(connection)
    ? connection.options
    : (connection as RedisUrlOptions);
  return buildUrlFromOptions(opts);
}
