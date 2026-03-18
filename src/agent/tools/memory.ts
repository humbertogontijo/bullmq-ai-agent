import { tool } from "@langchain/core/tools";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { v4 as uuidv4 } from "uuid";
import type { RunContext } from "../../options.js";
import { buildMemoryNamespace, buildContactMemoryNamespace } from "../../memory/AgentMemoryStore.js";
import {
  SAVE_MEMORY_TOOL_DESCRIPTION,
  SAVE_MEMORY_CONTENT_DESCRIPTION,
  SAVE_MEMORY_SCOPE_DESCRIPTION,
  DELETE_MEMORY_TOOL_DESCRIPTION,
  DELETE_MEMORY_ID_DESCRIPTION,
  DELETE_MEMORY_SCOPE_DESCRIPTION,
} from "../prompts.js";

type MemoryScope = "agent" | "contact";

function resolveNamespace(scope: MemoryScope, agentId: string, contactId: string): string[] {
  return scope === "agent"
    ? buildMemoryNamespace(agentId)
    : buildContactMemoryNamespace(agentId, contactId);
}

const saveSchema = {
  type: "object" as const,
  properties: {
    content: {
      type: "string" as const,
      description: SAVE_MEMORY_CONTENT_DESCRIPTION,
    },
    scope: {
      type: "string" as const,
      enum: ["agent", "contact"],
      description: SAVE_MEMORY_SCOPE_DESCRIPTION,
    },
  },
  required: ["content"],
};

const deleteSchema = {
  type: "object" as const,
  properties: {
    memoryId: {
      type: "string" as const,
      description: DELETE_MEMORY_ID_DESCRIPTION,
    },
    scope: {
      type: "string" as const,
      enum: ["agent", "contact"],
      description: DELETE_MEMORY_SCOPE_DESCRIPTION,
    },
  },
  required: ["memoryId", "scope"],
};

export function createSaveMemoryTool() {
  return tool(
    async (
      args: { content: string; scope?: MemoryScope },
      runnableConfig: LangGraphRunnableConfig,
    ) => {
      const configurable = runnableConfig?.configurable as RunContext | undefined;
      const store = configurable?.agentMemoryStore;
      const agentId = configurable?.agentId;
      const contactId = configurable?.contactId;
      const threadId = configurable?.thread_id;
      if (!store || !agentId || !contactId) {
        return JSON.stringify({ error: "Memory not available (missing agentMemoryStore, agentId, or contactId in context)" });
      }
      const scope: MemoryScope = args.scope ?? "contact";
      const key = uuidv4();
      const ns = resolveNamespace(scope, agentId, contactId);
      await store.put(ns, key, { content: args.content, threadId });
      return JSON.stringify({ saved: true, memoryId: key, scope });
    },
    {
      name: "save_memory",
      description: SAVE_MEMORY_TOOL_DESCRIPTION,
      schema: saveSchema,
    },
  );
}

export function createDeleteMemoryTool() {
  return tool(
    async (
      args: { memoryId: string; scope: MemoryScope },
      runnableConfig: LangGraphRunnableConfig,
    ) => {
      const configurable = runnableConfig?.configurable as RunContext | undefined;
      const store = configurable?.agentMemoryStore;
      const agentId = configurable?.agentId;
      const contactId = configurable?.contactId;
      if (!store || !agentId || !contactId) {
        return JSON.stringify({ error: "Memory not available (missing agentMemoryStore, agentId, or contactId in context)" });
      }
      const ns = resolveNamespace(args.scope, agentId, contactId);
      await store.delete(ns, args.memoryId);
      return JSON.stringify({ deleted: true, memoryId: args.memoryId, scope: args.scope });
    },
    {
      name: "delete_memory",
      description: DELETE_MEMORY_TOOL_DESCRIPTION,
      schema: deleteSchema,
    },
  );
}
