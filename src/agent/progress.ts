import { createMiddleware } from "langchain";
import { RunContext } from "../options.js";

/** Progress stages reported by the update-progress middleware. */
export type ProgressStage = "before_agent" | "before_model" | "after_model" | "after_agent";

/** Progress payload sent to job.updateProgress (matches client JobProgress). */
export interface ProgressPayload {
  stage: ProgressStage;
  [key: string]: unknown;
}

function reportProgress(runtime: { configurable?: Record<string, unknown> } | undefined, stage: ProgressStage): void {
  const configurable = runtime?.configurable as RunContext | undefined;
  const job = configurable?.job;
  if (job?.updateProgress) {
    void job.updateProgress({ stage });
  }
}

/**
 * Creates an agent middleware that reports progress at each stage (before_agent, before_model, after_model, after_agent).
 * Expects the BullMQ job to be passed in configurable at invoke time so it can call job.updateProgress({ stage }).
 */
export function createProgressMiddleware() {
  return createMiddleware({
    name: "ProgressMiddleware",
    beforeAgent: (_state, runtime) => {
      reportProgress(runtime, "before_agent");
    },
    beforeModel: (_state, runtime) => {
      reportProgress(runtime, "before_model");
    },
    afterModel: (_state, runtime) => {
      reportProgress(runtime, "after_model");
    },
    afterAgent: (_state, runtime) => {
      reportProgress(runtime, "after_agent");
    },
  });
}
