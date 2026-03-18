import type { BaseMessage } from "@langchain/core/messages";
import { getBufferString, HumanMessage, RemoveMessage, SystemMessage } from "@langchain/core/messages";
import { createMiddleware, initChatModel } from "langchain";
import { z } from "zod";
import { clearThreadJobsAndRemoveJobsScript } from "../../commands/index.js";
import { QUEUE_NAMES, runContextContextSchema, type RunContext } from "../../options.js";
import {
  buildCompletedKey,
  buildJobIdPrefix,
  buildThreadJobsKey,
} from "../../queues/queueKeys.js";
import { REMOVE_ALL_MESSAGES } from "../../utils/messageMapping.js";
import {
  formatPreviousConversationSummary,
  SUMMARIZATION_PROMPT_TEMPLATE,
} from "../prompts.js";



/** Default message count above which summarization runs. */
export const DEFAULT_SUMMARIZATION_THRESHOLD = 50;

export interface SummarizationMiddlewareParams {
  /** When thread history message count exceeds this, run summarization and clear thread-jobs. Default 50. */
  historyThreshold?: number;
}

/**
 * Creates a summarization middleware that runs after the history middleware. When historyMessages
 * (from state) exceeds a threshold it:
 * 1. Asks the AI to summarize the conversation.
 * 2. Clears the thread-jobs set and removes those BullMQ job keys via a transactional Lua script.
 * 3. Returns the summary as the only history message (prefix), so the model sees summary + current messages.
 *
 * No Redis thread-summary key; the summary is added as a prefix message in the messages for this run.
 *
 * Must run after the history middleware so it reads state.historyMessages.
 * Expects run context (redis, thread_id, queueKeyPrefix, chatModelOptions) via config.context.
 */
export function createSummarizationMiddleware(params: SummarizationMiddlewareParams = {}) {
  const threshold = params.historyThreshold ?? DEFAULT_SUMMARIZATION_THRESHOLD;

  return createMiddleware({
    name: "SummarizationMiddleware",
    stateSchema: z.object({
      /** Can override historyMessages set by history middleware with a single summary message. */
      historyMessages: z.array(z.any()).optional(),
    }),
    contextSchema: runContextContextSchema,
    beforeAgent: async (state, runtime) => {
      const ctx = runtime?.context as RunContext | undefined;
      const { redis, thread_id, queueKeyPrefix, chatModelOptions } = ctx ?? {};
      if (!redis || !thread_id || !queueKeyPrefix || !chatModelOptions) {
        return;
      }

      const historyMessages = (state?.historyMessages ?? []) as BaseMessage[];
      if (historyMessages.length < threshold) {
        return;
      }

      const model = await initChatModel(
        `${chatModelOptions.provider}:${chatModelOptions.model}`,
        {
          apiKey: chatModelOptions.apiKey,
          temperature: 0,
          maxTokens: 2048,
        }
      );
      const formattedMessages = getBufferString(historyMessages);
      const formattedPrompt = SUMMARIZATION_PROMPT_TEMPLATE.replace(
        "{messages}",
        formattedMessages
      );
      const response = await model.invoke([new HumanMessage(formattedPrompt)]);
      const content = (response as { content?: string })?.content;
      const summary = typeof content === "string" ? content : String(content ?? "");

      const threadJobsKey = buildThreadJobsKey(queueKeyPrefix, QUEUE_NAMES.AGENT, thread_id);
      const completedKey = buildCompletedKey(queueKeyPrefix, QUEUE_NAMES.AGENT);
      const jobIdPrefix = buildJobIdPrefix(queueKeyPrefix, QUEUE_NAMES.AGENT);
      await redis.eval(clearThreadJobsAndRemoveJobsScript, 2, threadJobsKey, completedKey, jobIdPrefix);

      const summaryMessage = new SystemMessage(formatPreviousConversationSummary(summary));
      const currentMessages = state?.messages ?? [];
      return {
        historyMessages: [],
        messages: [
          new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
          summaryMessage,
          ...currentMessages,
        ],
      };
    },
  });
}
