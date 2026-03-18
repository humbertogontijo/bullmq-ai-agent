-- Upsert an item: ZADD to sorted set + SET data key.
-- On update, preserves the original createdAt from the existing entry.
-- KEYS[1]: sorted set key ({prefix}:store:{namespace})
-- KEYS[2]: data key ({prefix}:store:{namespace}:{key})
-- ARGV[1]: score (updatedAt timestamp ms)
-- ARGV[2]: member key
-- ARGV[3]: JSON data string (Item)
-- Returns: 1

local existing = redis.call("GET", KEYS[2])
if existing then
  local old = cjson.decode(existing)
  local new_data = cjson.decode(ARGV[3])
  new_data.createdAt = old.createdAt
  redis.call("SET", KEYS[2], cjson.encode(new_data))
else
  redis.call("SET", KEYS[2], ARGV[3])
end
redis.call("ZADD", KEYS[1], ARGV[1], ARGV[2])
return 1
