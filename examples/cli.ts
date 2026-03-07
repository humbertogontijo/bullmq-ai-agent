/**
 * CLI helper for examples: start workers and create a client using env (REDIS_URL, etc.).
 * When run directly (npm run chat), starts an interactive menu to test each feature with the agent.
 * Prompts for OpenAI API key on first run and caches it in .agent.json.
 */
import * as clack from "@clack/prompts";
import type { StoredMessage } from "@langchain/core/messages";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MessageRole } from "bullmq-ai-agent";
import { BullMQAgentClient, BullMQAgentWorker } from "bullmq-ai-agent";
import type { ModelOptions } from "bullmq-ai-agent";

function toStoredMessages(history: Array<{ role: MessageRole; content: string }>): StoredMessage[] {
  return history.map((m) => ({
    type: (m.role === "assistant" ? "ai" : "human") as "human" | "ai",
    data: {
      content: m.content,
      role: m.role,
      name: undefined,
      tool_call_id: undefined,
    },
  }));
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
 * Start all workers (agent, tools, subagents, ingest). Pass embeddingModelOptions (e.g. from getModelOptions(apiKey)).
 * Use env for connection and queue names.
 */
export async function startWorkers(embeddingModelOptions: ModelOptions): Promise<BullMQAgentWorker> {
  const workers = new BullMQAgentWorker({ ...defaultOptions, embeddingModelOptions });
  await workers.start();
  return workers;
}

/**
 * Create a client with default options from env. Call client.close() when done.
 */
export function createClient(): BullMQAgentClient {
  return new BullMQAgentClient(defaultOptions);
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
  modelOptions: { chatModelOptions: ModelOptions; embeddingModelOptions: ModelOptions },
  history: Array<{ role: MessageRole; content: string }>,
  userInput: string
): Promise<{ lastMessage: string | undefined; done: boolean }> {
  history.push({ role: "user", content: userInput });

  const agentId = "default";
  const threadId = SESSION_ID;
  const messages = toStoredMessages([...history]);
  const options = { ...modelOptions, messages };
  let result = await client.runAndWait(agentId, threadId, options, WAIT_TTL);

  while (result.status === "interrupted") {
    const payload = result.interruptPayload;
    if (payload?.type === "human") {
      const msg = payload?.message ?? "Human input required";
      const humanInput = orExit(
        await clack.text({
          message: `[Human-in-the-loop] ${msg}`,
          placeholder: "Your response...",
        })
      );
      result = await client.resumeAndWait(agentId, threadId, humanInput, {}, WAIT_TTL);
      if (result.status === "interrupted") {
        continue;
      }
    }
  }

  if (result.lastMessage) {
    history.push({ role: "assistant", content: result.lastMessage });
  }
  return { lastMessage: result.lastMessage, done: true };
}

async function flowBasicChat(client: BullMQAgentClient, workers: BullMQAgentWorker, modelOptions: { chatModelOptions: ModelOptions; embeddingModelOptions: ModelOptions }): Promise<void> {
  const history: Array<{ role: MessageRole; content: string }> = [];
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
      const { lastMessage } = await runTurn(client, modelOptions, history, input);
      if (lastMessage) clack.note(lastMessage, "Assistant");
    } catch (err) {
      clack.log.error(String(err));
    }

    const again = orExit(await clack.confirm({ message: "Send another message?" }));
    if (!again) break;
  }
}

async function flowRag(client: BullMQAgentClient, workers: BullMQAgentWorker, modelOptions: { chatModelOptions: ModelOptions; embeddingModelOptions: ModelOptions }): Promise<void> {
  clack.note("RAG: ingest documents, then ask questions that use search_knowledge.", "RAG");

  const ingestNow = orExit(
    await clack.confirm({
      message: "Ingest default sample documents first?",
      initialValue: true,
    })
  );

  if (ingestNow) {
    clack.log.message("Ingesting...");
    await client.ingest({
      agentId: "default",
      source: {
        type: 'text',
        content: "The BullMQ agent runs tools and subagents as queue jobs. It uses Redis for the queue and for RAG.",
        metadata: { source: "readme" }
      },
    });
    clack.log.message("Waiting for ingest to process (3s)...");
    await new Promise((r) => setTimeout(r, 3000));
  }

  const history: Array<{ role: MessageRole; content: string }> = [];
  while (true) {
    const question = orExit(
      await clack.text({
        message: "Question (uses RAG / search_knowledge)",
        placeholder: "e.g. How does human-in-the-loop work?",
      })
    );
    if (!question.trim()) continue;

    try {
      const { lastMessage } = await runTurn(client, modelOptions, history, question);
      if (lastMessage) clack.note(lastMessage, "Assistant");
    } catch (err) {
      clack.log.error(String(err));
    }

    const again = orExit(await clack.confirm({ message: "Ask another question?" }));
    if (!again) break;
  }
}

async function flowHumanInTheLoop(client: BullMQAgentClient, workers: BullMQAgentWorker, modelOptions: { chatModelOptions: ModelOptions; embeddingModelOptions: ModelOptions }): Promise<void> {
  clack.note("Send a message that triggers request_human_approval, then respond when prompted.", "Human-in-the-loop");

  const message =
    "Before you answer, use the request_human_approval tool to ask: 'Do you allow me to proceed?' Then say hello.";
  const history: Array<{ role: MessageRole; content: string }> = [];

  try {
    const { lastMessage } = await runTurn(client, modelOptions, history, message);
    if (lastMessage) clack.note(lastMessage, "Assistant");
  } catch (err) {
    clack.log.error(String(err));
  }
}

async function main(): Promise<void> {
  const scriptPath = fileURLToPath(import.meta.url);
  const isRunDirectly = process.argv[1] === scriptPath || process.argv[1]?.endsWith("cli.ts") || process.argv[1]?.endsWith("cli.js");
  if (!isRunDirectly) return;

  clack.intro("BullMQ Agent — Interactive CLI");

  const apiKey = await ensureOpenAIKey();
  const modelOptions = getModelOptions(apiKey);

  const workers = await startWorkers(modelOptions.embeddingModelOptions);
  const client = createClient();

  try {
    while (true) {
      const choice = orExit(
        await clack.select({
          message: "What do you want to do?",
          options: [
            { value: "basic", label: "Basic chat", hint: "Free-form conversation" },
            { value: "rag", label: "RAG", hint: "Ingest + ask questions with search_knowledge" },
            { value: "hitl", label: "Human-in-the-loop", hint: "Request approval then resume" },
            { value: "exit", label: "Exit" },
          ],
        })
      );

      if (choice === "exit") break;

      switch (choice) {
        case "basic":
          await flowBasicChat(client, workers, modelOptions);
          break;
        case "rag":
          await flowRag(client, workers, modelOptions);
          break;
        case "hitl":
          await flowHumanInTheLoop(client, workers, modelOptions);
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
