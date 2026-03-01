/**
 * Build a redis URL for node-redis from BullMQ/IORedis ConnectionOptions.
 */

import type { ConnectionOptions } from 'bullmq';

export function connectionToRedisUrl(connection: ConnectionOptions): string {
  const c = connection as Record<string, unknown>;
  if (typeof c?.url === 'string') return c.url;
  const host = (c?.host as string) ?? 'localhost';
  const port = (c?.port as number) ?? 6379;
  const password = c?.password as string | undefined;
  const db = c?.db as number | undefined;
  let url = `redis://${host}:${port}`;
  if (password) url = url.replace('redis://', `redis://:${encodeURIComponent(password)}@`);
  if (db !== undefined && db !== 0) url += `/${db}`;
  return url;
}
