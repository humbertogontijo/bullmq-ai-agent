/**
 * CLI helper for examples: start workers and create a client using env (REDIS_URL, etc.).
 * When run directly (npm run chat), starts an interactive menu to test each feature with the agent.
 * Prompts for OpenAI API key on first run and caches it in .agent.json.
 * Job results are the final stream state (messages). Human-in-the-loop: client detects resume when the last message is an AI message with tool_calls and calls resumeTool with the human response content.
 */
import * as clack from "@clack/prompts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MessageRole, TodoItem, TodoItemsGraph, TodoSequenceSpec } from "bullmq-ai-agent";
import { BullMQAgentClient, BullMQAgentWorker, isResumeRequired } from "bullmq-ai-agent";
import type { ModelOptions } from "bullmq-ai-agent";
import type { AgentJobResult, StoredAgentState, StoredMessage } from "bullmq-ai-agent";

function toStoredMessages(history: Array<{ role: MessageRole; content: string }>): StoredMessage[] {
  return history.map((m) => {
    const isAi = m.role === "assistant";
    return {
      type: (isAi ? "ai" : "human") as "human" | "ai",
      data: isAi
        ? { content: m.content, name: undefined, tool_calls: [] }
        : { content: m.content, name: undefined, tool_call_id: undefined },
    };
  });
}

const AGENT_JSON_PATH = join(process.cwd(), ".agent.json");

interface AgentJson {
  openaiApiKey?: string;
}

function loadAgentJson(): AgentJson {
  if (!existsSync(AGENT_JSON_PATH)) return {};
  try {
    const raw = readFileSync(AGENT_JSON_PATH, "utf-8");
    return JSON.parse(raw) as AgentJson;
  } catch {
    return {};
  }
}

function saveAgentJson(data: AgentJson): void {
  writeFileSync(AGENT_JSON_PATH, JSON.stringify(data, null, 2), "utf-8");
}

async function ensureOpenAIKey(): Promise<string> {
  if (process.env.OPENAI_API_KEY?.trim()) return process.env.OPENAI_API_KEY;
  const cached = loadAgentJson();
  if (cached.openaiApiKey?.trim()) {
    process.env.OPENAI_API_KEY = cached.openaiApiKey;
    return cached.openaiApiKey;
  }
  const key = orExit(
    await clack.password({
      message: "OpenAI API key not found. Enter your key (stored in .agent.json for next runs):",
      mask: "*",
      validate: (v) => (v?.trim() ? undefined : ("Key is required" as const)),
    })
  );
  process.env.OPENAI_API_KEY = key;
  saveAgentJson({ ...cached, openaiApiKey: key });
  clack.log.success("API key saved to .agent.json");
  return key;
}

/** Build chat and embedding model options from env (only used in CLI). Library does not read process.env. */
function getModelOptions(apiKey: string): { chatModelOptions: ModelOptions; embeddingModelOptions: ModelOptions } {
  return {
    chatModelOptions: { provider: "openai", model: "gpt-4o-mini", apiKey },
    embeddingModelOptions: { provider: "openai", model: "text-embedding-3-small", apiKey },
  };
}

const defaultOptions = {
  connection: { url: process.env.REDIS_URL ?? "redis://localhost:6379" },
  prefix: process.env.QUEUE_PREFIX ?? "bullmq-ai-agent",
};

/**
 * Start all workers (agent, tools, subagents, ingest). Pass chatModelOptions and embeddingModelOptions (e.g. from getModelOptions(apiKey)).
 * Use env for connection and queue names.
 */
export async function startWorkers(
  modelOptions: { chatModelOptions: ModelOptions; embeddingModelOptions: ModelOptions },
  options?: { getTodos?: (ctx: { agentId: string; threadId: string }) => TodoSequenceSpec | Promise<TodoSequenceSpec> },
): Promise<BullMQAgentWorker> {
  const workers = new BullMQAgentWorker({ ...defaultOptions, ...modelOptions, enableAgentMemory: true, getTodos: options?.getTodos });
  await workers.start();
  return workers;
}

/** True if wait() result is the fallback (no_job or job_not_found). */
function isFallbackResult(result: unknown): result is { status: "no_job" | "job_not_found"; message?: string } {
  return typeof result === "object" && result !== null && "status" in result && ((result as { status: string }).status === "no_job" || (result as { status: string }).status === "job_not_found");
}

/** Get last AI message content as string from a chunk's messages. */
function getLastMessageFromChunk(chunk: StoredAgentState): string | undefined {
  const messages = chunk?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.type === "ai" && m.data?.content != null) {
      return typeof m.data.content === "string" ? m.data.content : JSON.stringify(m.data.content);
    }
  }
  return undefined;
}

/** Log todos (content + status + fulfillment when present) to the console. */
function logTodos(todos: TodoItem[]): void {
  if (!todos?.length) return;
  clack.log.message("Todos:");
  for (let i = 0; i < todos.length; i++) {
    const t = todos[i];
    const line =
      t.status === "completed" && t.fulfillment !== ""
        ? `  ${i + 1}. [${t.status}] ${t.content} → ${t.fulfillment}`
        : `  ${i + 1}. [${t.status}] ${t.content}`;
    clack.log.message(line);
  }
}

/** Get human-in-the-loop prompt from last AI message tool call (e.g. request_human_approval reason). */
function getHumanPromptFromChunk(chunk: StoredAgentState): string {
  const messages = chunk?.messages ?? [];
  const last = messages[messages.length - 1];
  if (last?.type === "ai") {
    const toolCalls = (last.data as { tool_calls?: Array<{ name: string; args?: { reason?: string } }> })?.tool_calls;
    const hitl = Array.isArray(toolCalls) ? toolCalls.find((tc) => tc.name === "request_human_approval") : undefined;
    if (hitl?.args?.reason) return hitl.args.reason;
  }
  return "Human input required";
}

// --- Interactive CLI (when run directly) ---

const SESSION_ID = "cli-session";
const WAIT_TTL = 120_000;

function orExit<T>(value: T | symbol): T {
  if (clack.isCancel(value)) {
    clack.cancel("Goodbye.");
    process.exit(0);
  }
  return value as T;
}

async function runTurn(
  client: BullMQAgentClient,
  _modelOptions: { chatModelOptions: ModelOptions; embeddingModelOptions: ModelOptions },
  userInput: string,
  threadId: string = SESSION_ID
): Promise<{ lastMessage?: string; todos?: TodoItem[]; done: boolean }> {
  const agentId = "default";
  const messages = toStoredMessages([{ role: "user", content: userInput }]);
  const runResult = await client.run(agentId, threadId, { messages, ttl: WAIT_TTL });
  let result: AgentJobResult = await runResult.promise;

  if (isFallbackResult(result)) {
    return { done: true };
  }

  while (result && isResumeRequired(result)) {
    const prompt = getHumanPromptFromChunk(result);
    const humanInput = orExit(
      await clack.text({
        message: `[Human-in-the-loop] ${prompt}`,
        placeholder: "Your response...",
      })
    );
    const resumeResult = await client.resumeTool(agentId, threadId, { content: humanInput, ttl: WAIT_TTL });
    result = await resumeResult.promise;
    if (isFallbackResult(result)) {
      return { done: true };
    }
  }

  const lastMessage = result ? getLastMessageFromChunk(result) : undefined;
  return { lastMessage, todos: result?.todos, done: true };
}

async function flowBasicChat(client: BullMQAgentClient, modelOptions: { chatModelOptions: ModelOptions; embeddingModelOptions: ModelOptions }): Promise<void> {
  clack.note("Chat with the agent. You'll be prompted for each message. Choose 'Back to menu' to exit this mode.", "Basic chat");

  while (true) {
    const input = orExit(
      await clack.text({
        message: "Your message",
        placeholder: "Type a message...",
      })
    );
    if (!input.trim()) continue;

    try {
      const { lastMessage } = await runTurn(client, modelOptions, input);
      if (lastMessage) clack.note(lastMessage, "Assistant");
    } catch (err) {
      clack.log.error(String(err));
    }

    const again = orExit(await clack.confirm({ message: "Send another message?" }));
    if (!again) break;
  }
}

async function flowRag(client: BullMQAgentClient, modelOptions: { chatModelOptions: ModelOptions; embeddingModelOptions: ModelOptions }): Promise<void> {
  clack.note("RAG: ingest documents, then ask questions that use the retrieve tool.", "RAG");

  const ingestNow = orExit(
    await clack.confirm({
      message: "Ingest default sample documents first?",
      initialValue: true,
    })
  );

  if (ingestNow) {
    clack.log.message("Ingesting...");
    const ingestResult = await client.ingest({
      agentId: "default",
      source: {
        type: 'text',
        content: "The BullMQ agent runs tools and subagents as queue jobs. It uses Redis for the queue and for RAG.",
        metadata: { source: "readme" }
      },
      ttl: WAIT_TTL,
    });
    const ingestOut = await ingestResult.promise;
    if (isFallbackResult(ingestOut)) {
      clack.log.warn("Ingest job could not be found.");
    } else {
      clack.log.message(`Ingested ${ingestOut.documents} document(s) (${ingestOut.chunks} chunks).`);
    }
  }

  while (true) {
    const question = orExit(
      await clack.text({
        message: "Question (uses RAG / retrieve)",
        placeholder: "e.g. How does human-in-the-loop work?",
      })
    );
    if (!question.trim()) continue;

    try {
      const { lastMessage } = await runTurn(client, modelOptions, question);
      if (lastMessage) clack.note(lastMessage, "Assistant");
    } catch (err) {
      clack.log.error(String(err));
    }

    const again = orExit(await clack.confirm({ message: "Ask another question?" }));
    if (!again) break;
  }
}

async function flowHumanInTheLoop(client: BullMQAgentClient, modelOptions: { chatModelOptions: ModelOptions; embeddingModelOptions: ModelOptions }): Promise<void> {
  clack.note("Send a message that triggers request_human_approval, then respond when prompted.", "Human-in-the-loop");

  const message =
    "Before you answer, use the request_human_approval tool to ask: 'Do you allow me to proceed?' Then say hello.";

  try {
    const { lastMessage } = await runTurn(client, modelOptions, message);
    if (lastMessage) clack.note(lastMessage, "Assistant");
  } catch (err) {
    clack.log.error(String(err));
  }
}

async function flowMemory(client: BullMQAgentClient, modelOptions: { chatModelOptions: ModelOptions; embeddingModelOptions: ModelOptions }): Promise<void> {
  clack.note(
    "Test cross-thread memory: tell the agent something to remember in one thread, then start a new thread and see if it recalls.",
    "Agent Memory"
  );

  const threadA = `memory-thread-a-${Date.now()}`;
  const threadB = `memory-thread-b-${Date.now()}`;
  const agentId = "default";

  // Thread A: tell the agent to remember something
  const saveMsg = orExit(
    await clack.text({
      message: "[Thread A] Tell the agent something to remember",
      placeholder: "e.g. My name is Alice and I prefer TypeScript.",
    })
  );
  if (!saveMsg.trim()) return;

  clack.log.message(`Sending to Thread A (${threadA})...`);
  try {
    const messages = toStoredMessages([{ role: "user", content: `Please remember this using the save_memory tool: ${saveMsg}` }]);
    const runResult = await client.run(agentId, threadA, { messages, ttl: WAIT_TTL });
    const result = await runResult.promise;
    if (!isFallbackResult(result)) {
      const reply = getLastMessageFromChunk(result as AgentJobResult);
      if (reply) clack.note(reply, "Assistant (Thread A)");
    }
  } catch (err) {
    clack.log.error(String(err));
    return;
  }

  // Thread B: ask if the agent remembers
  const recallMsg = orExit(
    await clack.text({
      message: "[Thread B] Ask the agent what it remembers (different thread, same agentId)",
      placeholder: "e.g. What do you know about me?",
    })
  );
  if (!recallMsg.trim()) return;

  clack.log.message(`Sending to Thread B (${threadB})...`);
  try {
    const messages = toStoredMessages([{ role: "user", content: recallMsg }]);
    const runResult = await client.run(agentId, threadB, { messages, ttl: WAIT_TTL });
    const result = await runResult.promise;
    if (!isFallbackResult(result)) {
      const reply = getLastMessageFromChunk(result as AgentJobResult);
      if (reply) clack.note(reply, "Assistant (Thread B)");
    }
  } catch (err) {
    clack.log.error(String(err));
  }
}

async function flowTodos(client: BullMQAgentClient, modelOptions: { chatModelOptions: ModelOptions; embeddingModelOptions: ModelOptions }): Promise<void> {
  clack.note(
    "Todos guide the agent through a checklist. The agent sees the todos and works through them step by step.\n" +
    "On subsequent runs in the same thread, persisted todos are loaded from the previous job and new required todos are merged in.",
    "Todos"
  );

  const threadId = `todos-thread-${Date.now()}`;

  // First turn: the agent receives the todos and starts working through them
  const firstMsg = "Hi! Please work through the todo list.";
  clack.log.message("Sending first message — agent will see the seeded todos...");
  try {
    const { lastMessage, todos } = await runTurn(client, modelOptions, firstMsg, threadId);
    if (todos?.length) logTodos(todos);
    if (lastMessage) clack.note(lastMessage, "Assistant");
  } catch (err) {
    clack.log.error(String(err));
    return;
  }

  // Continue chatting in the same thread so the agent can keep progressing
  while (true) {
    const again = orExit(await clack.confirm({ message: "Continue in this thread?" }));
    if (!again) break;

    const input = orExit(
      await clack.text({
        message: "Your message",
        placeholder: "Provide info the agent needs, or ask it to continue...",
      })
    );
    if (!input.trim()) continue;

    try {
      const { lastMessage, todos } = await runTurn(client, modelOptions, input, threadId);
      if (todos?.length) logTodos(todos);
      if (lastMessage) clack.note(lastMessage, "Assistant");
    } catch (err) {
      clack.log.error(String(err));
    }
  }
}

async function main(): Promise<void> {
  const scriptPath = fileURLToPath(import.meta.url);
  const isRunDirectly = process.argv[1] === scriptPath || process.argv[1]?.endsWith("cli.ts") || process.argv[1]?.endsWith("cli.js");
  if (!isRunDirectly) return;

  clack.intro("BullMQ Agent — Interactive CLI");

  const apiKey = await ensureOpenAIKey();
  const modelOptions = getModelOptions(apiKey);

  const workers = await startWorkers(modelOptions, {
    getTodos: ({ threadId }): TodoSequenceSpec => {
      if (!threadId.startsWith("todos-thread-")) return [];
      const p = (content: string): TodoItem => ({
        content,
        status: "pending",
        fulfillment: "",
      });
      /** Graph segment for CLI testing: `items` first, then `next` as a single todo item after both are done. */
      const contactGraph: TodoItemsGraph = {
        items: [p("Get the client's email address"), p("Get the client's shipping address")],
        next: p("Confirm all details with the client"),
      };
      return [p("Get the client's full name"), contactGraph];
    },
  });
  const client = new BullMQAgentClient({ ...defaultOptions });

  try {
    while (true) {
      const choice = orExit(
        await clack.select({
          message: "What do you want to do?",
          options: [
            { value: "basic", label: "Basic chat", hint: "Free-form conversation" },
            { value: "rag", label: "RAG", hint: "Ingest + ask questions with retrieve" },
            { value: "hitl", label: "Human-in-the-loop", hint: "Request approval then resume" },
            { value: "memory", label: "Memory", hint: "Cross-thread memory: remember facts across conversations" },
            { value: "todos", label: "Todos", hint: "Guide the agent with a seeded todo checklist" },
            { value: "exit", label: "Exit" },
          ],
        })
      );

      if (choice === "exit") break;

      switch (choice) {
        case "basic":
          await flowBasicChat(client, modelOptions);
          break;
        case "rag":
          await flowRag(client, modelOptions);
          break;
        case "hitl":
          await flowHumanInTheLoop(client, modelOptions);
          break;
        case "memory":
          await flowMemory(client, modelOptions);
          break;
        case "todos":
          await flowTodos(client, modelOptions);
          break;
      }
    }

    clack.outro("Done. Workers and client closed.");
  } finally {
    await workers.close();
    await client.close();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
