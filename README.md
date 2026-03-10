# bullmq-ai-agent

Scalable AI agent orchestration powered by [BullMQ](https://docs.bullmq.io/) and [LangChain](https://js.langchain.com/).

Define subagents, system prompts, and per-agent config (getAgentConfig), connect any LLM, and let BullMQ handle the rest — tool execution, persistent checkpoints, and Redis-backed reliability. Built-in tools include RAG (search knowledge), human-in-the-loop (request approval), and escalate_to_human (full handoff).

## Features

- **Subagents & system prompts** — Configure subagents with `name`, `description`, and `systemPrompt`; optional `tools` and `model` per subagent; when `subagentId` is set, that subagent runs directly
- **Provider agnostic** — Works with any LLM supported by LangChain (`openai`, `anthropic`, `google-genai`, etc.) via `chatModelOptions` and `embeddingModelOptions`
- **Persistent checkpoints** — LangGraph checkpointing in Redis; resume runs after interrupts
- **Human-in-the-loop** — Built-in `request_human_approval` tool; agent can pause and wait for operator input, then resume with `resume` / `resumeAndWait`
- **RAG** — Built-in `search_knowledge` tool; ingest documents per agent via `client.ingest()` and optional `VectorStoreProvider`
- **Redis-backed** — Queues and checkpoints in Redis; vector store uses [@langchain/redis](https://js.langchain.com/docs/integrations/vectorstores/redis) (Redis Stack recommended for RediSearch)
- **Type-safe** — Full TypeScript; `ModelOptions`, `RunOptions`, `Subagent`, `AgentConfig`, `Skill`, and queue types exported

## How It Works

```
┌─────────┐    run(agentId, threadId, { messages, subagentId? })
│  Client  │─────────────────────────────────────────────────────────────────▶ Agent Queue
└─────────┘                                                                           │
     ▲                                                                                ▼
     │    runAndWait / resumeAndWait                                            AgentWorker
     │    (job result: completed | interrupted)                                 (LangGraph)
     │                                                                                │
     │                                                                     tools: search_knowledge,
     │                                                                     request_human_approval
     │                                                                                │
     │    ingest({ agentId, source }) ─────────────────────────────────────▶ Ingest Queue
     │                                                                                │
     └───────────────────────────────────────────────────────────────────────────────┘
```

- **Client** enqueues `run` or `resume` jobs with `agentId`, `threadId`, and options. Use `runAndWait` / `resumeAndWait` for sync-style flows.
- **AgentWorker** runs the LangGraph agent with built-in tools; checkpoints are stored in Redis.
- **Tools, and ingest** run as separate BullMQ workers; the library starts them together via `BullMQAgentWorker`.

Client and worker must use the same Redis `connection` and, if you set it, the same `prefix`.

### Subagents

A **subagent** has `name`, `description`, and `systemPrompt`; optional `tools` and `model`. When you pass `subagentId` in `RunOptions`, that subagent runs directly. You can also use `getAgentConfig(agentId)` on the worker to load per-agent system prompt and default model/temperature.

Sessions are identified by `agentId` + `threadId`. You pass **messages** (conversation history) on each `run`; the library does not persist chat history itself — checkpoint state is used for resuming interrupted runs.

### RAG (Retrieval Augmented Generation)

When you call `client.ingest({ agentId, source })`, documents are queued and processed by the ingest worker. The built-in **search_knowledge** tool queries the vector store for that agent. Documents are stored per agent (index: `{agentId}-rag`).

- **Source format:** `{ type: 'url' | 'file' | 'text', content: string, metadata?: Record<string, unknown> }`. For `url`, `content` is the URL; for `file`, `content` is the file path; for `text`, `content` is the raw text.
- **Embeddings:** Set `embeddingModelOptions` on the worker (e.g. OpenAI). The library does not read `process.env`; pass `apiKey` from your app or CLI.
- **Redis:** Vector store uses `@langchain/redis`; for production, use [Redis Stack](https://redis.io/docs/stack/) (e.g. `docker run -d -p 6379:6379 redis/redis-stack`).

## Installation

```bash
npm install bullmq-ai-agent
```

Install a LangChain provider for your LLM and embeddings:

```bash
npm install @langchain/openai
# or @langchain/anthropic, @langchain/google-genai, etc.
```

You need a running Redis instance (and Redis Stack if using the vector store):

```bash
docker run -d --name redis -p 6379:6379 redis/redis-stack
```

## Quick Start

### 1. Define subagents (optional)

Subagents provide system prompts and optional tools/model. Each has `name`, `description`, and `systemPrompt`. Optional `tools` and `model` override the default for that subagent.

```typescript
import type { Subagent } from "bullmq-ai-agent";

const subagents: Subagent[] = [
  {
    name: "default",
    description: "General-purpose assistant",
    systemPrompt: [{ type: "text", text: "You are a helpful assistant. Use search_knowledge when needed." }],
  },
];
```

### 2. Start the worker

`BullMQAgentWorker` starts the agent, tools, and ingest workers. **embeddingModelOptions** is required (used for RAG and ingest).

```typescript
import { BullMQAgentWorker } from "bullmq-ai-agent";

const worker = new BullMQAgentWorker({
  connection: { host: "localhost", port: 6379 },
  subagents,
  embeddingModelOptions: {
    provider: "openai",
    model: "text-embedding-3-small",
    apiKey: process.env.OPENAI_API_KEY!,
  },
});

await worker.start();
```

### 3. Use the client

Use **BullMQAgentClient** to enqueue runs and ingest documents. Pass **messages** (conversation history) on each run; the library does not read `process.env` for API keys.

```typescript
import { BullMQAgentClient } from "bullmq-ai-agent";
import { mapChatMessagesToStoredMessages } from "@langchain/core/messages";

const client = new BullMQAgentClient({
  connection: { host: "localhost", port: 6379 },
});

const agentId = "my-agent";
const threadId = "user-123";
const messages = []; // or load from your store

// Append user message and run
const userMessage = { role: "user" as const, content: "What can you do?" };
const storedMessages = mapChatMessagesToStoredMessages([
  ...messages.map((m) => ({ role: m.role, content: m.content })),
  userMessage,
]);

const result = await client.runAndWait(
  agentId,
  threadId,
  {
    messages: storedMessages,
  },
  120_000
);

if (result.status === "interrupted") {
  // Human-in-the-loop: pass user response and resume
  const resumed = await client.resumeAndWait(
    agentId,
    threadId,
    result.interruptPayload,
    {},
    120_000
  );
  console.log(resumed.lastMessage);
} else {
  console.log(result.lastMessage);
}

// Ingest documents for RAG
await client.ingest({
  agentId,
  source: { type: "text", content: "Your document text here.", metadata: { source: "readme" } },
});

await client.close();
```

## API Reference

### BullMQAgentClient

| Method | Description |
|--------|-------------|
| `run(agentId, threadId, options)` | Enqueue a run job. Returns `{ agentId, threadId, jobId }`. |
| `runAndWait(agentId, threadId, options, ttl?)` | Run and wait for completion or interrupt. When interrupted by a tool/subagent, waits for the worker-enqueued resume automatically; returns when done or when a human-in-the-loop interrupt occurs. Default `ttl` is 2 minutes. |
| `resume(agentId, threadId, result)` | Enqueue a resume job after a human-in-the-loop interrupt (fire-and-forget). |
| `resumeAndWait(agentId, threadId, result, options?, ttl?)` | Resume and wait for the next completion or interrupt. Default `ttl` is 2 minutes. |
| `ingest({ agentId, source })` | Add a document to the agent’s RAG index. `source`: `{ type: 'url'\|'file'\|'text', content: string, metadata? }`. |
| `getAgentJob(jobId)` | Get an agent-queue job by id. |
| `close()` | Close queue connections. |

**RunOptions**

- `subagentId?: string` — When set, that subagent runs directly (must match a subagent name on the worker).
- `messages: StoredMessage[]` — Conversation history for this run (e.g. from `mapChatMessagesToStoredMessages`).

If `ttl` is exceeded on `runAndWait` or `resumeAndWait`, the wait fails (the job may still be running). Use a larger `ttl` for long runs or poll `getAgentJob(jobId)` for fire-and-forget flows.

### BullMQAgentWorker

| Option | Type | Description |
|--------|------|-------------|
| `connection` | `QueueOptions` | Redis connection (BullMQ). Client and worker must use the same connection and `prefix`. |
| `prefix?` | `string` | Queue/key prefix (e.g. `QUEUE_PREFIX` env). Defaults to no prefix; use the same value as the client. |
| `documentConnection?` | `ConnectionOptions` | Redis for vector store; defaults to `connection`. |
| `subagents?` | `Subagent[]` | Subagents with `name`, `description`, `systemPrompt`; optional `tools` and `model`. |
| `getAgentConfig?` | `(agentId: string) => Promise<AgentConfig \| undefined>` | Per-agent config: systemPrompt, default model, temperature, maxTokens. |
| `skills?` | `Skill[]` | Progressive disclosure: `name`, `description`, `content`; load_skill tool loads full content. |
| `embeddingModelOptions` | `ModelOptions` | **Required.** Used for RAG and ingest. |

**Methods**

- `start(): Promise<void>` — Connect Redis and start all workers (agent, tools, ingest).
- `close(): Promise<void>` — Gracefully close all workers, the flow producer, and Redis connections.

### Run result (AgentJobResult)

- `status: 'completed' | 'interrupted'`  
- `lastMessage?: string` — Last AI text content when completed.  
- `interruptPayload?: InterruptPayload` — When `status === 'interrupted'`:
  - **Human-in-the-loop:** `{ type: 'human', message?: string, options?: Record<string, unknown> }`. Pass the human's response (any value, e.g. `"Approved"` or `{ approved: true }`) as the second argument to `resume()` / `resumeAndWait()`.

### ModelOptions

```typescript
interface ModelOptions {
  provider: string;  // e.g. "openai"
  model: string;     // e.g. "gpt-4o-mini"
  apiKey: string;
}
```

Pass from your app or CLI; the library does not read `process.env`. To load API keys from a `.env` file, call `import "dotenv/config"` (or equivalent) in your app or CLI entrypoint before using the library.

### Subagent

```typescript
interface Subagent {
  name: string;
  description: string;
  systemPrompt: SystemMessageFields;  // from @langchain/core/messages
  tools?: StructuredToolInterface[];   // optional tools for this subagent
  model?: ModelOptions;                // optional chat model override for this subagent
}
```

### Ingest document source

```typescript
// URL: content = full URL
{ type: "url", content: "https://example.com/page", metadata?: {} }

// File: content = file path
{ type: "file", content: "/path/to/file.txt", metadata?: {} }

// Inline text
{ type: "text", content: "Raw text...", metadata?: {} }
```

## Built-in tools

The agent is configured with these tools (no need to register them yourself):

- **search_knowledge** — RAG search over the agent’s ingested documents (when ingest worker and `embeddingModelOptions` are used).
- **request_human_approval** — Pauses the run and returns an interrupt; resume with `resume` / `resumeAndWait` and the human’s response.
## Examples

The package ships an interactive CLI (also in the repo at `examples/cli.ts`) that starts workers and runs basic chat, RAG, and human-in-the-loop flows. From an installed package, run:

```bash
npx tsx node_modules/bullmq-ai-agent/examples/cli.ts
```

(If you get a module not found error for `@clack/prompts`, install it: `npm install @clack/prompts`.)

From the repo, run (this builds and installs the package first so the example resolves the library):

```bash
npm run example
```

You will be prompted for an OpenAI API key (stored in `.agent.json` for next runs). Use `REDIS_URL` (e.g. `redis://localhost:6379`) for connection and optional `QUEUE_PREFIX` for the queue prefix (the library uses the `prefix` option; default is `bullmq-ai-agent`).

## Exports

- **Client / Worker:** `BullMQAgentClient`, `BullMQAgentWorker`, `BullMQAgentWorkerOptions`
- **Types:** `RunOptions`, `RunResult`, `ResumeOptions`, `IngestDocument`, `IngestOptions`, `AgentJobResult`, `EscalationPayload`, `InterruptPayload`, `HumanInterruptPayload`, `MessageRole`, `ModelOptions`, `RunContext`, `AgentConfig`, `Skill`, `Subagent`
- **Queues:** `createAgentQueue`, `createIngestQueue`, `createToolsQueue`, `QUEUE_NAMES` (queue name constants for custom workers or monitoring)
- **Agent / RAG:** `compileGraph`, `VectorStoreProvider`, `VectorStoreProviderOptions`

## Contributing

Contributions are welcome. Please open an issue or submit a pull request.

## License

[MIT](LICENSE)
