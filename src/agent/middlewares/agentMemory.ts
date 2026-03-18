import { RemoveMessage, SystemMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";
import { z } from "zod";
import { runContextContextSchema, type RunContext } from "../../options.js";
import { DEFAULT_SEARCH_LIMIT, buildMemoryNamespace, buildContactMemoryNamespace } from "../../memory/AgentMemoryStore.js";
import { AGENT_MEMORY_SYSTEM_PROMPT, formatMemoryScopeContents } from "../prompts.js";
import { REMOVE_ALL_MESSAGES } from "../../utils/messageMapping.js";

export interface AgentMemoryMiddlewareParams {
  /** Maximum number of memory entries to load per scope per run. Default 50. */
  maxMemories?: number;
}

/**
 * Middleware that loads cross-thread memories from two scopes — agent
 * (shared) and contact (per-user) — and injects them as an ephemeral
 * system message for each model call.
 *
 * Modelled after deepagents' `createMemoryMiddleware` but uses
 * Redis-backed {@link AgentMemoryStore} and `beforeModel`/`afterModel`
 * instead of `wrapModelCall` (so the injected message is removed after
 * the call and never persists in BullMQ job data or thread history).
 *
 * The memory system prompt (with comprehensive guidelines on scopes,
 * when/how to save, and when to delete) is **always** injected — even
 * when no memories exist yet — so the agent knows about the memory
 * system from the start.
 *
 * - beforeAgent: loads memories from both namespaces via
 *   {@link AgentMemoryStore} and builds the combined system message.
 * - beforeModel: prepends the memory system message before other system
 *   messages (matching deepagents' prepend-via-concat pattern).
 * - afterModel: removes the injected memory message via RemoveMessage.
 */
export function createAgentMemoryMiddleware(params: AgentMemoryMiddlewareParams = {}) {
  const maxMemories = params.maxMemories ?? DEFAULT_SEARCH_LIMIT;

  return createMiddleware({
    name: "AgentMemoryMiddleware",
    stateSchema: z.object({
      agentMemoryMessages: z.array(z.any()).optional(),
    }),
    contextSchema: runContextContextSchema,
    beforeAgent: async (_state, runtime) => {
      const ctx = runtime?.context as RunContext | undefined;
      const store = ctx?.agentMemoryStore;
      const agentId = ctx?.agentId;
      const contactId = ctx?.contactId;
      if (!store || !agentId || !contactId) {
        return;
      }

      const agentNs = buildMemoryNamespace(agentId);
      const contactNs = buildContactMemoryNamespace(agentId, contactId);

      const [agentItems, contactItems] = await Promise.all([
        store.search(agentNs, { limit: maxMemories }),
        store.search(contactNs, { limit: maxMemories }),
      ]);

      const text = AGENT_MEMORY_SYSTEM_PROMPT
        .replace("{agent_memory_contents}", formatMemoryScopeContents(agentItems))
        .replace("{contact_memory_contents}", formatMemoryScopeContents(contactItems));

      const memoryMessage = new SystemMessage(text);
      return { agentMemoryMessages: [memoryMessage] };
    },
    beforeModel: (state) => {
      const agentMemoryMessages = state?.agentMemoryMessages ?? [];
      if (!agentMemoryMessages.length) return;

      const systemMessages = (state?.messages ?? []).filter(
        (m: unknown) => SystemMessage.isInstance(m),
      );
      const otherMessages = (state?.messages ?? []).filter(
        (m: unknown) => !SystemMessage.isInstance(m),
      );

      return {
        messages: [
          new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
          ...agentMemoryMessages,
          ...systemMessages,
          ...otherMessages,
        ],
      };
    },
    afterModel: (state) => {
      const agentMemoryMessages = state?.agentMemoryMessages ?? [];
      if (!agentMemoryMessages.length) return;
      return {
        messages: agentMemoryMessages
          .filter((m: { id?: string }) => m.id != null)
          .map((m: { id?: string }) => new RemoveMessage({ id: m.id! })),
      };
    },
  });
}
