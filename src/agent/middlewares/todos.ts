import { createMiddleware } from "langchain";
import { z } from "zod";

import { runContextContextSchema, type RunContext } from "../../options.js";
import type { TodoItem } from "../../queues/types.js";

/**
 * Merge persisted todos with required todos from the getTodos callback.
 * Required todos whose `content` is not already present in persisted todos
 * are appended as `"pending"`. Persisted todos (including completed) are
 * always preserved.
 */
function mergeTodos(persisted: TodoItem[], required: TodoItem[]): TodoItem[] {
  const existingContents = new Set(persisted.map((t) => t.content));
  const missing = required.filter((t) => !existingContents.has(t.content));
  return [...persisted, ...missing];
}

/**
 * Middleware that seeds the `todos` state by merging user-defined required
 * todos (from the `getTodos` callback in RunContext) with persisted todos
 * already loaded by the history middleware.
 *
 * Must be placed **after** `createHistoryMiddleware` (which loads persisted
 * todos from previous job return values into `state.todos`) and **before**
 * `todoListMiddleware` (which owns the `write_todos` tool).
 *
 * Expects `getTodos` on RunContext via config.context at invoke time.
 */
export function createTodoPersistenceMiddleware() {
  return createMiddleware({
    name: "TodoPersistenceMiddleware",
    stateSchema: z.object({
      todos: z.array(z.object({
        content: z.string(),
        status: z.enum(["pending", "in_progress", "completed"]),
      })).default([]),
    }),
    contextSchema: runContextContextSchema,
    beforeAgent: async (state, runtime) => {
      const ctx = runtime?.context as RunContext | undefined;
      if (!ctx?.getTodos) return;

      const persisted: TodoItem[] = state?.todos ?? [];
      const required = await ctx.getTodos({
        agentId: ctx.agentId,
        threadId: ctx.thread_id,
        contactId: ctx.contactId,
        metadata: ctx.metadata,
      });

      const todos = mergeTodos(persisted, required);
      if (todos.length > 0) {
        return { todos };
      }
    },
  });
}
