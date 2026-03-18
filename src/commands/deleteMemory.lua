-- Atomically delete an item: ZREM from sorted set + DEL data key.
-- KEYS[1]: sorted set key ({prefix}:store:{namespace})
-- KEYS[2]: data key ({prefix}:store:{namespace}:{key})
-- ARGV[1]: member key
-- Returns: number of members removed from the sorted set (0 or 1).

local removed = redis.call("ZREM", KEYS[1], ARGV[1])
redis.call("DEL", KEYS[2])
return removed
