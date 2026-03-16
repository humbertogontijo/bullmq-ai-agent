# bullmq-ai-agent

Scalable AI agent orchestration powered by [BullMQ](https://docs.bullmq.io/) and [LangChain](https://js.langchain.com/).

Define subagents, system prompts, and per-agent config (getAgentConfig), connect any LLM, and let BullMQ handle the rest — tool execution and Redis-backed reliability. Built-in tools include RAG (search knowledge) and human-in-the-loop (request approval).

## Features

- **Subagents & system prompts** — Configure subagents with `name`, `description`, and `systemPrompt`; optional `tools` and `model` per subagent; when `subagentId` is set, that subagent runs directly
- **Provider agnostic** — Works with any LLM supported by LangChain (`openai`, `anthropic`, `google-genai`, etc.) via `chatModelOptions` and `embeddingModelOptions`
- **Thread history from job results** — No separate checkpointer; the worker builds conversation history from previous jobs in the same thread (job return values). Each run uses `threadId` and a unique `jobId` (`threadId/<snowflake>`) so older job results can be loaded and concatenated.
- **Human-in-the-loop** — Built-in `request_human_approval` tool; the agent pauses and the worker returns the serialized state (messages). The client detects “resume needed” when the last message is an AI message with `request_human_approval` tool_calls, then calls `client.resumeTool(..., { content })`; the worker fetches the last job's state and builds the tool message.
- **Resume = run with full messages** — Resuming after an interrupt is a normal `run()` with the full message list (e.g. previous result messages plus the human’s tool reply) ; the worker uses only those messages (no prior job history prepended).
- **RAG** — Built-in `search_knowledge` tool; ingest documents per agent via `client.ingest()` and optional `VectorStoreProvider`
- **Redis-backed** — Queues in Redis; vector store uses [@langchain/redis](https://js.langchain.com/docs/integrations/vectorstores/redis) (Redis Stack recommended for RediSearch)
- **Type-safe** — Full TypeScript; `ModelOptions`, `RunOptions`, `Subagent`, `AgentConfig`, `Skill`, and queue types exported

## How It Works

```
┌─────────┐    run(agentId, threadId, { messages, subagentId? })
│  Client  │─────────────────────────────────────────────────────────────────▶ Agent Queue
└─────────┘                                                                           │
     ▲                                                                                ▼
     │    result.promise → AgentJobResult (messages)                             AgentWorker
     │    resumeTool(..., { content }) or resume(..., { messages })                (LangGraph)
     │                                                                                │
     │                                                                     tools: search_knowledge,
     │                                                                     request_human_approval
     │                                                                                │
     │    ingest({ agentId, source }) ─────────────────────────────────────▶ Ingest Queue
     │                                                                                │
     └───────────────────────────────────────────────────────────────────────────────┘
```

- **Client** enqueues `run` or `resumeTool` jobs with `agentId`, `threadId`, and options. Use `result.jobId` and `await result.promise` to wait for the job. Pass `ttl` (ms) in options when creating the run/resumeTool/resume/ingest/search to set the wait timeout. **resumeTool** sends only `content`; the worker fetches the last job for the thread and builds the tool message. **resume()** is still available: same as `run()` with full messages.
- **AgentWorker** runs the LangGraph agent with built-in tools. On each completed job it registers the job id in a Redis sorted set per thread so `resumeTool` can fetch the last job. Job result is the final stream state (serialized messages). When the graph interrupts (e.g. human-in-the-loop), the client uses `isResumeRequired(result)` then `resumeTool(..., { content })`.
- **Thread history** is built by the worker from previous job return values in the same thread (SCAN by `threadId`, load job results, concatenate messages). No Redis checkpointer; history lives in job results.
- **Tools, and ingest** run as separate BullMQ workers; the library starts them together via `BullMQAgentWorker`.

Client and worker must use the same Redis `connection` and, if you set it, the same `prefix`.

### Thread history and resume

1. **Thread history is job-result–based** — For each run, the worker finds previous jobs in the same thread (by `threadId`, `jobId` format `threadId/<snowflake>`), loads their return values, and prepends those messages to the current input. So conversation history is reconstructed from completed (or interrupted) job results, not from a separate store. **Limit:** at most 500 previous jobs are loaded per run by default; very long threads may not have full history in context. Use the optional `maxHistoryMessages` worker option to pass a lower limit into the Lua script (it caps the number of previous jobs loaded).
2. **resumeTool (preferred)** — After a human-in-the-loop interrupt, the client calls `client.resumeTool(agentId, threadId, { content: humanInput })`. The worker fetches the last executed job for that thread from a Redis sorted set, loads its return value, finds the last AI message's `request_human_approval` tool_call_id, builds the tool message, and runs the graph. Requires a previous run for that thread so the job was registered in the thread-jobs set.
3. **resume()** — Alternative: build the full message list (previous result messages plus the human's tool reply) and call `client.resume(agentId, threadId, { messages })`; the worker uses only those messages (no prior job history prepended).
4. **Human-in-the-loop detection** — The client considers “resume required” when the last message in the job result is an AI message with a `request_human_approval` tool call. Use `isResumeRequired(result)` to detect that; then call `resumeTool(agentId, threadId, { content })` or `resume(..., { messages })`.

### Subagents

A **subagent** has `name`, `description`, and `systemPrompt`; optional `tools` and `model`. When you pass `subagentId` in `RunOptions`, that subagent runs directly. You can also use `getAgentConfig(agentId)` on the worker to load per-agent system prompt and default model/temperature.

Sessions are identified by `agentId` + `threadId`. On each `run`, the worker prepends messages from previous jobs in the thread and registers the job in a Redis sorted set for that thread. When resuming via `resumeTool()`, the worker loads the last job's state and builds the tool message; when resuming via `resume()`, only the given `messages` are used.

### RAG (Retrieval Augmented Generation)

When you call `client.ingest({ agentId, source })`, documents are queued and processed by the ingest worker. The built-in **search_knowledge** tool queries the vector store for that agent. Documents are stored per agent (index: `{agentId}-rag`).

- **Source format:** `{ type: 'url' | 'file' | 'text', content: string, metadata?: Record<string, unknown> }`. For `url`, `content` is the URL; for `file`, `content` is the file path; for `text`, `content` is the raw text.
- **Embeddings:** Set `embeddingModelOptions` on the worker (e.g. OpenAI). The library does not read `process.env`; pass `apiKey` from your app or CLI.
- **Redis:** Vector store uses `@langchain/redis`; for production, use [Redis Stack](https://redis.io/docs/stack/) (e.g. `docker run -d -p 6379:6379 redis/redis-stack`).

### Extending with custom tools

You can add CRM-specific or domain tools by passing a `tools` array to `BullMQAgentWorker`. These are merged with the built-in tools (search_knowledge, request_human_approval, escalate_to_human, load_skill).

```typescript
import { tool } from "@langchain/core/tools";
import { BullMQAgentWorker } from "bullmq-ai-agent";

const myTool = tool(
  async (input, runtime) => {
    const ctx = runtime.configurable; // RunContext: agentId, thread_id, metadata, etc.
    // e.g. call your CRM API using ctx.agentId or ctx.metadata
    return { ok: true };
  },
  { name: "update_ticket", description: "Update the support ticket", schema: { ... } }
);

const worker = new BullMQAgentWorker({
  connection: { host: "localhost", port: 6379 },
  chatModelOptions: { ... },
  embeddingModelOptions: { ... },
  tools: [myTool],
});

await worker.start();
```

Tools receive `RunContext` via `runtime.configurable` (and `config.context` in middleware), so they can access `agentId`, `thread_id`, `metadata`, and the current job.

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
import { BullMQAgentClient, isResumeRequired } from "bullmq-ai-agent";
import type { StoredMessage } from "bullmq-ai-agent";

const client = new BullMQAgentClient({
  connection: { host: "localhost", port: 6379 },
});

const agentId = "my-agent";
const threadId = "user-123";
const messages: StoredMessage[] = []; // or load from your store

// Append user message and run
const userMessage = { type: "human" as const, data: { content: "What can you do?", role: "user" as const, name: undefined, tool_call_id: undefined } };
const runResult = await client.run(agentId, threadId, {
  messages: [...messages, userMessage],
});
let result = await runResult.promise; // pass ttl in run options if needed, e.g. { messages, ttl: 120_000 }

// Human-in-the-loop: if last message is AI with request_human_approval, resume with user input (resumeTool uses last job state)
while (result && !("status" in result && (result.status === "no_job" || result.status === "job_not_found")) && isResumeRequired(result)) {
  const humanInput = "Approved"; // e.g. from prompt or UI
  const resumeResult = await client.resumeTool(agentId, threadId, { content: humanInput });
  result = await resumeResult.promise; // pass ttl in options if needed
}

// Result is final state (messages); get last AI content from result.messages if needed

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
| `run(agentId, threadId, options)` | Enqueue a run job. Returns `ClientResult<AgentJobResult>`; use `await result.promise` for the job result. Pass `ttl` in options for wait timeout (ms). Job result is the final stream state (`{ messages: StoredMessage[] }`). |
| `resumeTool(agentId, threadId, options)` | Resume after human-in-the-loop: send only `options.content`; the worker fetches the last job for the thread and builds the tool message. Returns `ClientResult<AgentJobResult>`. Requires a previous run for that thread. |
| `resume(agentId, threadId, options)` | Resume with full messages (same as `run()` with `options.messages`). Use when you already have the full message list. |
| `ingest({ agentId, source })` | Add a document to the agent’s RAG index. `source`: `{ type: 'url'\|'file'\|'text', content: string, metadata? }`. |
| `getAgentJob(jobId)` | Get an agent-queue job by id. |
| `close()` | Close queue connections. |

**RunOptions**

- `subagentId?: string` — When set, that subagent runs directly (must match a subagent name on the worker).
- `messages: StoredMessage[]` — Conversation history for this run.

**ResumeToolOptions**

- `content: string` — Human response for the `request_human_approval` tool.
- `subagentId?: string`, `metadata?: Record<string, unknown>`, `onProgress?`, `ttl?: number` — Same as run options.

**ResumeOptions**

- `messages: StoredMessage[]` — Full message list for the run.

If `ttl` (passed in run/resumeTool/resume/ingest/search options) is exceeded when awaiting the result, the wait fails (the job may still be running). Use a larger `ttl` for long runs or poll `getAgentJob(jobId)` for fire-and-forget flows.

**Helpers for human-in-the-loop**

- **`isResumeRequired(chunk: StoredAgentState): boolean`** — Returns true when the last message in the chunk is an AI message with a `request_human_approval` tool call.
- **`resumeTool(agentId, threadId, { content })`** — Preferred: worker builds the tool message from the last job. Alternatively, build full messages and pass to `client.resume(..., { messages })`.

### BullMQAgentWorker

| Option | Type | Description |
|--------|------|-------------|
| `connection` | `QueueOptions` | Redis connection (BullMQ). Client and worker must use the same connection and `prefix`. |
| `prefix?` | `string` | Queue/key prefix (e.g. `QUEUE_PREFIX` env). Defaults to no prefix; use the same value as the client. |
| `documentConnection?` | `ConnectionOptions` | Redis for vector store; defaults to `connection`. |
| `subagents?` | `Subagent[]` | Subagents with `name`, `description`, `systemPrompt`; optional `tools` and `model`. |
| `getAgentConfig?` | `(agentId: string) => Promise<AgentConfig \| undefined>` | Per-agent config: systemPrompt, default model, temperature, maxTokens. |
| `skills?` | `Skill[]` | Progressive disclosure: `name`, `description`, `content`; load_skill tool loads full content. |
| `tools?` | `StructuredToolInterface[]` | Custom tools merged with built-in tools (search_knowledge, request_human_approval, escalate_to_human, load_skill). |
| `embeddingModelOptions` | `ModelOptions` | **Required.** Used for RAG and ingest. |

**Methods**

- `start(): Promise<void>` — Connect Redis and start all workers (agent, tools, ingest).
- `close(): Promise<void>` — Gracefully close all workers, the flow producer, and Redis connections.

### Run result (AgentJobResult)

Job return value is the final stream state (serializable):

- `messages: StoredMessage[]` — Full message list at the end of the run or at the interrupt. When the run was interrupted by `request_human_approval`, the last message is an AI message with `tool_calls`; use `isResumeRequired(result)` to detect that, then call `resumeTool(agentId, threadId, { content: humanInput })` or build full messages and `resume(..., { messages })`.

When the job is missing or not found, awaiting the result may resolve to a fallback object with `status: 'no_job' | 'job_not_found'` (see `AwaitableResultFallback` in types). Use `"status" in result` to narrow the type before reading `messages`.

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
- **request_human_approval** — Pauses the run and returns an interrupt; resume with `resumeTool(..., { content })` or `resume(..., { messages })`.
- **escalate_to_human** — Full handoff to a human (no resume). Inspect the last AI message's `tool_calls` in `result.messages` for reason/context to route and display.
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

- **Client / Worker:** `BullMQAgentClient`, `ClientResult`, `BullMQAgentWorker`, `BullMQAgentWorkerOptions`, `BullMQAgentClientOptions`
- **Types:** `RunOptions`, `RunResult`, `ResumeOptions`, `ResumeToolOptions`, `AwaitableResultFallback`, `AgentJobResult`, `StoredAgentState`, `StoredMessage`, `MessageRole`, `ModelOptions`, `RunContext`, `AgentConfig`, `Skill`, `Subagent`
- **Helpers:** `getLastRequestHumanApprovalToolCall`, `isResumeRequired`
- **Queues:** `createAgentQueue`, `createIngestQueue`, `createSearchQueue`, `QUEUE_NAMES`
- **Agent / RAG:** `compileGraph`, `VectorStoreProvider`, `VectorStoreProviderOptions`, `createProgressMiddleware`, `ProgressPayload`, `ProgressStage`

## Contributing

Contributions are welcome. Please open an issue or submit a pull request.

## License

[MIT](LICENSE)
