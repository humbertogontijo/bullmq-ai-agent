/**
 * Per-session configuration (autoExecuteTools, humanInTheLoop).
 * Stored in Redis keyed by sessionId; worker reads it when processing jobs.
 */

export interface SessionConfig {
  /** When true, tools run automatically without user confirmation. Default false. */
  autoExecuteTools?: boolean;
  /** When true, the agent gets a human_in_the_loop tool to request operator input. Default false. */
  humanInTheLoop?: boolean;
}

const DEFAULT_SESSION_CONFIG: Required<SessionConfig> = {
  autoExecuteTools: false,
  humanInTheLoop: false,
};

export function getDefaultSessionConfig(): Required<SessionConfig> {
  return { ...DEFAULT_SESSION_CONFIG };
}

/** Redis-like client: get/set by key. BullMQ Queue.client and Worker connection are compatible. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
}

const KEY_PREFIX = 'session_config:';

function sessionConfigKey(queuePrefix: string, sessionId: string): string {
  return (queuePrefix ?? '') + KEY_PREFIX + sessionId;
}

/**
 * Load session config from Redis. Returns defaults when the session has no stored config.
 */
export async function getSessionConfig(
  redis: RedisLike,
  queuePrefix: string,
  sessionId: string,
): Promise<Required<SessionConfig>> {
  const key = sessionConfigKey(queuePrefix, sessionId);
  const raw = await redis.get(key);
  if (raw == null || raw === '') return getDefaultSessionConfig();
  try {
    const parsed = JSON.parse(raw) as SessionConfig;
    return {
      autoExecuteTools: parsed.autoExecuteTools ?? DEFAULT_SESSION_CONFIG.autoExecuteTools,
      humanInTheLoop: parsed.humanInTheLoop ?? DEFAULT_SESSION_CONFIG.humanInTheLoop,
    };
  } catch {
    return getDefaultSessionConfig();
  }
}

/**
 * Persist session config in Redis. Merges with existing config so partial updates are supported.
 */
export async function setSessionConfig(
  redis: RedisLike,
  queuePrefix: string,
  sessionId: string,
  config: SessionConfig,
): Promise<void> {
  const current = await getSessionConfig(redis, queuePrefix, sessionId);
  const merged: SessionConfig = {
    ...(config.autoExecuteTools !== undefined && { autoExecuteTools: config.autoExecuteTools }),
    ...(config.humanInTheLoop !== undefined && { humanInTheLoop: config.humanInTheLoop }),
  };
  const next: Required<SessionConfig> = {
    autoExecuteTools: merged.autoExecuteTools ?? current.autoExecuteTools,
    humanInTheLoop: merged.humanInTheLoop ?? current.humanInTheLoop,
  };
  const key = sessionConfigKey(queuePrefix, sessionId);
  await redis.set(key, JSON.stringify(next));
}
