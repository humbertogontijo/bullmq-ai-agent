-- Clear the thread-jobs set and remove all BullMQ job hashes + remove those job IDs from the completed set.
-- Atomic: run in a single EVAL so all steps succeed or none.
-- KEYS[1]: thread-jobs sorted set key (e.g. "bull:agent:thread-jobs:threadId")
-- KEYS[2]: BullMQ completed set key (e.g. "bull:agent:completed")
-- ARGV[1]: job key prefix (e.g. "bull:agent:")
-- Returns: number of jobs removed.

local thread_jobs_key = KEYS[1]
local completed_key = KEYS[2]
local prefix = ARGV[1]

local job_ids = redis.call("ZRANGE", thread_jobs_key, 0, -1)
local removed = 0
for _, job_id in ipairs(job_ids) do
  local job_key = prefix .. job_id
  redis.call("DEL", job_key)
  redis.call("ZREM", completed_key, job_id)
  removed = removed + 1
end
redis.call("DEL", thread_jobs_key)
return removed
