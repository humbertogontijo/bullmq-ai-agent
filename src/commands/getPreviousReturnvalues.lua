-- Load previous jobs' return values for a thread from the thread-jobs sorted set.
-- KEYS[1]: thread-jobs sorted set key.
-- ARGV[1]: current_ts (number, exclude jobs with ts >= this)
-- ARGV[2]: job_id_prefix (e.g. "bull:agent:")
-- ARGV[3]: max_jobs (optional, number; max number of previous jobs to return; default 500)
-- Returns: array of returnvalue strings (or "" if missing), in ascending job timestamp order.
-- When the set does not exist, ZRANGEBYSCORE returns an empty list.

local current_ts = tonumber(ARGV[1])
local prefix = ARGV[2]
local max_jobs = tonumber(ARGV[3])
if max_jobs == nil or max_jobs <= 0 then
  max_jobs = 500
end

-- ZRANGEBYSCORE key min max [LIMIT offset count]: ascending score order (oldest first). (current_ts) = exclusive.
local job_ids = redis.call("ZRANGEBYSCORE", KEYS[1], "-inf", "(" .. tostring(current_ts), "LIMIT", 0, max_jobs)
local out = {}
for _, job_id in ipairs(job_ids) do
  local job_key = prefix .. job_id
  local rv = redis.call("HGET", job_key, "returnvalue")
  table.insert(out, rv or "")
end
return out
