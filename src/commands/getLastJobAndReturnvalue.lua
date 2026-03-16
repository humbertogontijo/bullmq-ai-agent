-- Fetch the last job ID for a thread and its return value in one round-trip.
-- KEYS[1]: thread-jobs sorted set key (e.g. "bull:agent:thread-jobs:threadId")
-- ARGV[1]: job key prefix (e.g. "bull:agent:")
-- Returns: { jobId, returnvalue } or {} when no previous job.

local last_jobs = redis.call("ZREVRANGE", KEYS[1], 0, 0)
if #last_jobs == 0 then
  return {}
end
local job_id = last_jobs[1]
local job_key = ARGV[1] .. job_id
local returnvalue = redis.call("HGET", job_key, "returnvalue")
return { job_id, returnvalue or "" }
