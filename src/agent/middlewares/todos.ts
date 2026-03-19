import { AIMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { tool, type ToolRuntime } from "@langchain/core/tools";
import { Command } from "@langchain/langgraph";
import { createMiddleware } from "langchain";
import { z } from "zod";

import { runContextContextSchema, type RunContext } from "../../options.js";
import type { TodoItem } from "../../queues/types.js";
import {
  TODO_LIST_LINES_PARAM,
  TODO_LIST_MIDDLEWARE_PROMPT_BUILDER,
  WRITE_TODOS_TOOL_DESCRIPTION,
} from "../prompts.js";

const TodoSchema = z.object({
  content: z.string().describe("Content of the todo item"),
  status: z
    .enum(["pending", "in_progress", "completed"])
    .describe("Status of the todo"),
  fulfillment: z
    .string()
    .describe(
      "When marking as completed: the actual result or answer (e.g. the client's full name). Use empty string when the task has no concrete result to store."
    ),
});

const stateSchema = z.object({
  todos: z.array(TodoSchema).default([]),
});

const WRITE_TODOS_TOOL_NAME = "write_todos";

const PARALLEL_WRITE_TODOS_ERROR =
  "Error: The `write_todos` tool should never be called multiple times in parallel. Please call it only once per model invocation to update the todo list.";

/**
 * Merge persisted todos with required todos from the getTodos callback.
 * Required todos whose `content` is not already present in persisted todos
 * are appended as `"pending"`. Persisted todos (including completed) are
 * always preserved.
 */
function normalizeTodo(t: { content: string; status: TodoItem["status"]; fulfillment?: string }): TodoItem {
  return { ...t, fulfillment: t.fulfillment ?? "" };
}

function mergeTodos(persisted: TodoItem[], required: TodoItem[]): TodoItem[] {
  const active = persisted.filter((t) => t.status !== "completed");
  const existingContents = new Set(active.map((t) => t.content));
  const missing = required.filter((t) => !existingContents.has(t.content));
  return [...active.map(normalizeTodo), ...missing.map(normalizeTodo)];
}

/**
 * Middleware that (1) seeds the `todos` state by merging user-defined required
 * todos (from the `getTodos` callback in RunContext) with persisted todos
 * loaded by the history middleware, (2) provides the `write_todos` tool so the
 * agent can update the list, and (3) injects todo list context and workflow
 * instructions when todos are present.
 *
 * Must be placed **after** `createHistoryMiddleware` (which loads persisted
 * todos from previous job return values into `state.todos`).
 *
 * Expects `getTodos` on RunContext via config.context at invoke time when
 * you want to seed required todos.
 */
export function createTodoListMiddleware() {
  const toolDescription = WRITE_TODOS_TOOL_DESCRIPTION;

  const writeTodos = tool(
    (
      { todos }: { todos: Array<{ content: string; status: string; fulfillment: string }> },
      runtime: ToolRuntime<z.infer<typeof stateSchema>>
    ) => {
      const toolCallId = runtime.toolCall?.id ?? "";
      return new Command({
        update: {
          todos,
          messages: [
            new ToolMessage({
              content: `Updated todo list to ${JSON.stringify(todos)}`,
              tool_call_id: toolCallId,
            }),
          ],
        },
      });
    },
    {
      name: WRITE_TODOS_TOOL_NAME,
      description: toolDescription,
      schema: z.object({
        todos: z
          .array(TodoSchema)
          .describe("List of todo items to update"),
      }),
    }
  );

  return createMiddleware({
    name: "todoListMiddleware",
    stateSchema,
    contextSchema: runContextContextSchema,
    tools: [writeTodos],
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
    wrapModelCall: (request, handler) => {
      const todos = request.state?.todos ?? [];
      if (todos.length === 0) return handler(request);

      const lines = todos.map((t, i) => {
        const base = `${i + 1}. [${t.status}] ${t.content}`;
        return t.status === "completed" && t.fulfillment !== ""
          ? `${base} → ${t.fulfillment}`
          : base;
      });
      const todoPrompt = TODO_LIST_MIDDLEWARE_PROMPT_BUILDER.build({
        [TODO_LIST_LINES_PARAM]: lines.join("\n"),
      });
      const existingContent =
        typeof request.systemMessage.content === "string"
          ? [{ type: "text" as const, text: request.systemMessage.content }]
          : request.systemMessage.content;
      return handler({
        ...request,
        systemMessage: new SystemMessage({
          content: [
            ...existingContent,
            { type: "text" as const, text: todoPrompt },
          ],
        }),
      });
    },
    afterModel: (state) => {
      const messages = state.messages;
      if (!messages || messages.length === 0) return;

      const lastAiMsg = [...messages]
        .reverse()
        .find((msg) => AIMessage.isInstance(msg)) as AIMessage | undefined;
      if (
        !lastAiMsg?.tool_calls ||
        lastAiMsg.tool_calls.length === 0
      )
        return;

      const writeTodosCalls = lastAiMsg.tool_calls.filter(
        (tc) => tc.name === WRITE_TODOS_TOOL_NAME
      );
      if (writeTodosCalls.length > 1) {
        return {
          messages: writeTodosCalls.map(
            (tc) =>
              new ToolMessage({
                content: PARALLEL_WRITE_TODOS_ERROR,
                tool_call_id: tc.id ?? "",
                status: "error",
              })
          ),
        };
      }
    },
  });
}
