const AGENT_JOB_NAME_PREFIX = 'agent-';

export const getGoalIdFromJobName = (jobName: string): string => {
  const lastSegment = jobName.includes('/')
    ? jobName.slice(jobName.lastIndexOf('/') + 1)
    : jobName;
  return lastSegment.startsWith(AGENT_JOB_NAME_PREFIX)
    ? lastSegment.slice(AGENT_JOB_NAME_PREFIX.length)
    : lastSegment;
};

export const getJobNameFromGoalId = (goalId: string): string => {
    return `${AGENT_JOB_NAME_PREFIX}${goalId}`;
};