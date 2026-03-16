import { createMiddleware } from "langchain";
import { RunContext, runContextContextSchema } from "../../options.js";

/** Progress stages reported by the update-progress middleware. */
export type ProgressStage =
  | "before_agent"
  | "before_model"
  | "after_model"
  | "after_agent"
  | "before_tool"
  | "after_tool";

/** Progress payload sent to job.updateProgress (matches client JobProgress). */
export interface ProgressPayload {
  stage: ProgressStage;
  [key: string]: unknown;
}

function reportProgress(runtime: { context?: Record<string, unknown> } | undefined, stage: ProgressStage): void {
  const ctx = runtime?.context as RunContext | undefined;
  const job = ctx?.job;
  if (job?.updateProgress) {
    void job.updateProgress({ stage });
  }
}

/**
 * Creates an agent middleware that reports progress at each stage (before_agent, before_model, after_model, after_agent, before_tool, after_tool).
 * Uses beforeAgent/afterAgent, beforeModel/afterModel hooks and wrapModelCall/wrapToolCall to report progress around the agent, model, and tool invocations.
 * Expects the BullMQ job to be passed in config.context at invoke time so it can call job.updateProgress({ stage }).
 */
export function createProgressMiddleware() {
  return createMiddleware({
    name: "ProgressMiddleware",
    contextSchema: runContextContextSchema,
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
    wrapToolCall: async (request, handler) => {
      reportProgress(request.runtime, "before_tool");
      try {
        const result = await handler(request);
        reportProgress(request.runtime, "after_tool");
        return result;
      } catch (err) {
        reportProgress(request.runtime, "after_tool");
        throw err;
      }
    },
  });
}
