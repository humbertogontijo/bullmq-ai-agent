-- Clear all items in a namespace: DEL each data key + DEL sorted set.
-- KEYS[1]: sorted set key ({prefix}:store:{namespace})
-- ARGV[1]: data key prefix ({prefix}:store:{namespace}:)
-- Returns: number of entries cleared.

local ids = redis.call("ZRANGE", KEYS[1], 0, -1)
for _, id in ipairs(ids) do
  redis.call("DEL", ARGV[1] .. id)
end
redis.call("DEL", KEYS[1])
return #ids
