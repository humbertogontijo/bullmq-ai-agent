import { RedisSaver } from "../redis/RedisSaver.js";

let checkpointer: RedisSaver | null = null;

export interface GetCheckpointerOptions {
  /** Key prefix for checkpoint keys (e.g. "agent"). Enables multiple tenants in one Redis. */
  prefix?: string;
}

export async function getCheckpointer(
  redisUrl: string,
  options?: GetCheckpointerOptions
): Promise<RedisSaver> {
  if (!checkpointer) {
    checkpointer = await RedisSaver.fromUrl(redisUrl, {
      ttlConfig: {
        defaultTTL: 60 * 24, // 24 hours
        refreshOnRead: true,
      },
      prefix: options?.prefix,
    });
  }
  return checkpointer;
}
