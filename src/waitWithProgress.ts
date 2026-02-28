import type { Job, QueueEvents } from 'bullmq';

import type { JobProgress } from './types.js';

export interface ProgressSource {
  events: QueueEvents;
  isRelevant: (jobId: string, data: unknown) => boolean;
}

export async function waitForJobWithProgress<T>(
  job: Job,
  waitEvents: QueueEvents,
  onProgress?: (progress: JobProgress) => void,
  extraSources?: ProgressSource[]
): Promise<T> {
  const handlers: Array<{
    events: QueueEvents;
    handler: (args: { jobId: string; data: unknown }, id: string) => void;
  }> = [];

  if (onProgress) {
    const sources: ProgressSource[] =
      [
        {
          events: waitEvents,
          isRelevant: (jobId) => jobId === job.id,
        },
        ...(extraSources ?? []),
      ];

    for (const source of sources) {
      const { events, isRelevant } = source;
      const handler = (
        args: { jobId: string; data: unknown },
        _id: string,
      ) => {
        if (
          isRelevant(args.jobId, args.data) &&
          args.data &&
          typeof args.data === 'object'
        ) {
          onProgress(args.data as JobProgress);
        }
      };
      events.on('progress', handler);
      handlers.push({ events, handler });
    }
  }

  try {
    return await job.waitUntilFinished(waitEvents);
  } finally {
    for (const { events, handler } of handlers) {
      events.off('progress', handler);
    }
  }
}
