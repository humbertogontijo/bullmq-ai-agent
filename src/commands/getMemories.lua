-- Load items from a namespace sorted set (newest first) with limit + offset.
-- KEYS[1]: sorted set key ({prefix}:store:{namespace})
-- ARGV[1]: limit (max entries to return)
-- ARGV[2]: offset (number of entries to skip, default 0)
-- ARGV[3]: data key prefix ({prefix}:store:{namespace}:)
-- Returns: array of JSON data strings (newest first), skipping missing keys.

local limit = tonumber(ARGV[1])
if limit == nil or limit <= 0 then
  limit = 50
end
local offset = tonumber(ARGV[2]) or 0
local data_prefix = ARGV[3]

local ids = redis.call("ZREVRANGE", KEYS[1], offset, offset + limit - 1)
local out = {}
for _, id in ipairs(ids) do
  local data = redis.call("GET", data_prefix .. id)
  if data then
    table.insert(out, data)
  end
end
return out
