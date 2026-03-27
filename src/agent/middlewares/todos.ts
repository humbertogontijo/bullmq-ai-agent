import { SystemMessage, ToolMessage } from "@langchain/core/messages";
import { tool, type ToolRuntime } from "@langchain/core/tools";
import { Command } from "@langchain/langgraph";
import { createMiddleware } from "langchain";
import { z } from "zod";

import { runContextContextSchema, type RunContext } from "../../options.js";
import {
  flattenTodoSequence,
  normalizeTodoSequenceSpec,
  resolveTodos,
  type TodoItem,
  type TodoItemsGraph,
  type TodoSequenceSpec,
} from "../../queues/types.js";
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

const TodoItemsGraphSchema: z.ZodType<TodoItemsGraph> = z.lazy(() =>
  z.object({
    items: z.array(z.union([TodoSchema, TodoItemsGraphSchema])),
    next: z.union([TodoSchema, TodoItemsGraphSchema]).optional(),
  }),
);
const TodoSequenceSpecSchema = z.array(z.union([TodoSchema, TodoItemsGraphSchema]));

const stateSchema = z.object({
  todos: z.array(TodoSchema).default([]),
  /** Raw `getTodos` tree; set in `beforeAgent` and kept for the run so each `beforeModel` can merge it into `todos`. */
  todosRequiredSpec: TodoSequenceSpecSchema.optional(),
});

const WRITE_TODOS_TOOL_NAME = "write_todos";

/**
 * Resolves the spec against completion state, then merges: {@link mergeTodos} keeps **completed**
 * rows from `persisted` and appends **current required** leaves from the spec (see {@link mergeTodos}).
 */
function mergeFromSpec(spec: TodoSequenceSpec | undefined, persisted: TodoItem[]): TodoItem[] {
  if (!spec || spec.length === 0) return persisted;
  const coerced = normalizeTodoSequenceSpec(spec);
  const resolved = resolveTodos(coerced, persisted);
  const flattened = flattenTodoSequence(resolved);
  return mergeTodos(persisted, flattened);
}

/**
 * **Completed history + current required from spec:** all completed todos from `persisted` (by row),
 * then any `required` item whose `content` is not already among those completed. In-flight work is not
 * listed here; it comes from the spec slice produced by {@link resolveTodos} / {@link flattenTodoSequence}.
 */
function mergeTodos(persisted: TodoItem[], required: TodoItem[]): TodoItem[] {
  const requiredContents = new Set(required.map((t) => t.content));
  const completedHistory = persisted.filter((t) => t.status === "completed" && !requiredContents.has(t.content));
  return [...completedHistory, ...required];
}

/**
 * Middleware that (1) calls `getTodos` **once** in `beforeAgent` and stores the raw spec in
 * `todosRequiredSpec`; (2) on each `beforeModel`, merges that spec into `todos` (completed history from
 * persisted state plus the current required slice from the spec via {@link resolveTodos} and
 * {@link flattenTodoSequence}); (3) provides `write_todos` and injects todo prompts.
 *
 * Top-level **TodoItem** entries do not unlock later siblings until completed; **TodoItemsGraph**
 * uses `items` then `next` (sequential stages) with the same rule inside each segment.
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
      { todos }: { todos: TodoItem[] },
      runtime: ToolRuntime<z.infer<typeof stateSchema>>
    ) => {
      const toolCallId = runtime.toolCall?.id ?? "";
      const prior = runtime.state?.todos ?? [];
      const mergedTodos = mergeTodos(prior, todos);
      return new Command({
        update: {
          todos: mergedTodos,
          messages: [
            new ToolMessage({
              content: `Updated todo list to ${JSON.stringify(mergedTodos)}`,
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
    beforeAgent: async (_state, runtime) => {
      const ctx = runtime?.context as RunContext | undefined;
      if (!ctx?.getTodos) return;

      const todosRequiredSpec = await ctx.getTodos({
        agentId: ctx.agentId,
        threadId: ctx.thread_id,
        contactId: ctx.contactId,
        metadata: ctx.metadata,
      });

      return { todosRequiredSpec };
    },
    beforeModel: async (state) => {
      const spec = state?.todosRequiredSpec ?? [];
      if (spec.length === 0) return;

      const persisted = state?.todos ?? [];
      return { todos: mergeFromSpec(spec, persisted) };
    },
    wrapModelCall: (request, handler) => {
      const todos = request.state?.todos ?? [];
      if (todos.length === 0) return handler(request);

      const lines = todos.map((t, i) => {
        const base = `${i + 1}. [${t.status}] ${t.content}`;
        return t.status === "completed" && t.fulfillment
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
  });
}
