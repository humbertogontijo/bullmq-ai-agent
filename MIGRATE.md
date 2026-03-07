# Migration guide: pre-refactor → v0.2.x

This document helps you migrate from the previous version of `bullmq-ai-agent` to the refactored API (v0.2.x). The library was rewritten around a simpler worker/client model, LangGraph checkpoints, and built-in tools. Many APIs were renamed or removed.

---

## Summary of breaking changes

| Before | After |
|--------|--------|
| `AgentClient` | `BullMQAgentClient` |
| `AgentWorker` | `BullMQAgentWorker` |
| `sendPrompt(agentId, sessionId, prompt, options?)` | `run(agentId, threadId, { messages, chatModelOptions, goalId? })` |
| `sendCommand(agentId, sessionId, command, options?)` | `resume(agentId, threadId, result)` |
| `addDocument(agentId, source)` | `ingest({ agentId, source })` with different `source` shape |
| `getConversationHistory(sessionId)` | **Removed** — you manage history and pass `messages` on each `run` |
| `sessionId` | `threadId` (parameter name only; same concept) |
| Skills (AgentSkill + tools) | **Goals** (`id` + `systemPrompt`); tools are built-in |
| `llmConfig` on worker | **Removed** — pass `chatModelOptions` per run and `embeddingModelOptions` on worker |
| `rag?: { embedding, ... }` on worker | **Removed** — RAG is always available; set `embeddingModelOptions` on worker |
| `sessionConfig` (humanInTheLoop, autoExecuteTools) | Handled by built-in `request_human_approval` tool and resume flow |
| TypeBox tool schemas | Built-in tools use Zod; no user-defined tools in the default worker |
| Queue names (orchestrator, agent, etc.) | `agent`, `tools`, `subagents`, `ingest` |

---

## 1. Client: rename and new methods

### Class and constructor

```ts
// Before
import { AgentClient } from "bullmq-ai-agent";
const client = new AgentClient({ connection, jobRetention?, queuePrefix? });

// After
import { BullMQAgentClient } from "bullmq-ai-agent";
const client = new BullMQAgentClient({ connection }); // jobRetention/queuePrefix not in current API
```

### Sending a prompt → run with messages

**Before:** You sent a single prompt string; the client/session stored history.

```ts
const result = await client.sendPrompt(
  agentId,
  sessionId,
  "Find flights from SFO to JFK",
  { sessionConfig: { humanInTheLoop: true }, onProgress }
);
```

**After:** You pass the full conversation as **messages** (e.g. `StoredMessage[]`) and **chatModelOptions** on every run. History is not stored by the library; you persist it (e.g. in your DB or in memory) and pass it in each time.

```ts
import { mapChatMessagesToStoredMessages } from "@langchain/core/messages";

const messages = getStoredMessagesForThread(sessionId); // your storage
const newMessages = [...messages, { role: "user", content: "Find flights from SFO to JFK" }];
const stored = mapChatMessagesToStoredMessages(newMessages);

const result = await client.runAndWait(
  agentId,
  threadId, // same as sessionId
  {
    chatModelOptions: { provider: "openai", model: "gpt-4o-mini", apiKey: process.env.OPENAI_API_KEY! },
    goalId: "flight-booking",
    messages: stored,
  },
  120_000
);
```

- **sessionId** is now **threadId** (name only).
- **sendPrompt** is replaced by **run** (fire-and-forget) or **runAndWait** (wait for completion/interrupt).
- **sessionConfig** and **onProgress** are not in the current client API; human-in-the-loop is done via the built-in tool and **resume** / **resumeAndWait**.

### Resuming after interrupt → resume

**Before:**

```ts
if (result.status === "interrupted") {
  await client.sendCommand(agentId, sessionId, {
    type: "tool_approval",
    payload: { approved: { SearchFlights: true } },
  });
}
```

**After:** Pass the **interrupt payload** (or the human’s response) to **resume** or **resumeAndWait**. The worker uses this to continue the graph.

```ts
if (result.status === "interrupted") {
  const resumed = await client.resumeAndWait(
    agentId,
    threadId,
    result.interruptPayload, // or a shape the worker expects for human-in-the-loop
    {},
    120_000
  );
}
```

The exact shape of `interruptPayload` and what you pass to `resume` depends on the built-in `request_human_approval` tool and how the worker resumes (see worker code / examples).

### Adding documents → ingest

**Before:**

```ts
await client.addDocument(agentId, { type: "url", url: "https://example.com" });
await client.addDocument(agentId, { type: "file", path: "/path/to/file.txt" });
await client.addDocument(agentId, { type: "text", text: "Some text" });
```

**After:** Use **ingest** with a single **source** shape: `type` + **content** (no `url`/`path`/`text` keys).

```ts
await client.ingest({
  agentId,
  source: { type: "url", content: "https://example.com" },
});
await client.ingest({
  agentId,
  source: { type: "file", content: "/path/to/file.txt" },
});
await client.ingest({
  agentId,
  source: { type: "text", content: "Some text", metadata: { source: "inline" } },
});
```

### Conversation history

**Before:** `getConversationHistory(sessionId)` returned stored messages.

**After:** There is no `getConversationHistory`. You must:

- Keep conversation history in your own storage (DB, memory, etc.), and
- Pass **messages** (e.g. `StoredMessage[]`) into every **run**.

Checkpoint state in Redis is used for resuming interrupted runs, not for returning full chat history to the client.

---

## 2. Worker: goals instead of skills

### Class and constructor

**Before:** You configured **skills** (each with id, name, title, description, tools) and optional **llmConfig** and **rag**.

**After:** You configure **goals** (id + systemPrompt) and **embeddingModelOptions**. Tools are built-in (search_knowledge, request_human_approval, runSubagent); you do not register custom tools on the default worker.

```ts
// Before
const worker = new AgentWorker({
  connection,
  llmConfig: async () => ({ model: "openai:gpt-4o", apiKey: process.env.OPENAI_API_KEY }),
  skills: [flightSkill, hrSkill],
  rag: { embedding: { provider: "openai", apiKey: "..." } },
});

// After
import { BullMQAgentWorker } from "bullmq-ai-agent";
import type { Goal } from "bullmq-ai-agent";

const goals: Goal[] = [
  {
    id: "default",
    systemPrompt: [{ type: "text", text: "You are a helpful assistant. Use search_knowledge when needed." }],
  },
];

const worker = new BullMQAgentWorker({
  connection,
  goals,
  embeddingModelOptions: {
    provider: "openai",
    model: "text-embedding-3-small",
    apiKey: process.env.OPENAI_API_KEY!,
  },
});
await worker.start();
```

- **llmConfig** is gone: the **chat** model is chosen per run via **chatModelOptions** in `run()` / `runAndWait()`.
- **embeddingModelOptions** is **required** on the worker (used for RAG and ingest).
- **rag** as an optional block is removed; RAG is always available when the ingest worker and vector store are used (see README).

### Skills → goals

**Before:** A skill had `id`, `name`, `title`, `description`, and `tools` (TypeBox schemas + handlers).

**After:** A **goal** has only `id` and `systemPrompt` (array of `SystemMessageFields`). There are no user-defined tools in the default setup; the agent uses the built-in tools. To mimic “skills,” define one goal per “skill” and pass the appropriate `goalId` when calling `run()`.

---

## 3. Result and progress

### StepResult / AgentJobResult

**Before:** You got a `StepResult` with `history`, `status`, `interrupts`, `childrenValues`, etc.

**After:** The client’s **runAndWait** / **resumeAndWait** return an **AgentJobResult** (and agentId/threadId):

- `status: 'completed' | 'interrupted'`
- `lastMessage?: string`
- `interruptPayload?: unknown` (use this when calling `resume`)

There is no `history` array on this result; you maintain history yourself and pass it in as `messages` on the next `run`.

### Progress

**Before:** `onProgress` in `sendPrompt` received progress updates (e.g. phase).

**After:** The current client does not expose `onProgress`. Progress may still be updated on the BullMQ job; you would need to subscribe to job events or extend the client if you need this.

---

## 4. Queue names and low-level APIs

Queue names are now:

- `agent`
- `tools`
- `subagents`
- `ingest`

If you referenced queue names or used orchestrator/aggregator queues directly, update to these. The library exports `createAgentQueue`, `createIngestQueue`, `createSubagentsQueue`, `createToolsQueue` for custom usage.

---

## 5. Checklist

- [ ] Replace `AgentClient` with `BullMQAgentClient` and update constructor options.
- [ ] Replace `AgentWorker` with `BullMQAgentWorker`; add `embeddingModelOptions`; remove `llmConfig` and `rag`; replace `skills` with `goals` (id + systemPrompt).
- [ ] Replace `sendPrompt(agentId, sessionId, prompt, options)` with `run`/`runAndWait(agentId, threadId, { messages, chatModelOptions, goalId? })`.
- [ ] Implement your own conversation history storage and pass `messages` (e.g. `StoredMessage[]`) on each run.
- [ ] Replace `sendCommand(agentId, sessionId, command)` with `resume(agentId, threadId, result)` / `resumeAndWait(..., result.interruptPayload, ...)`.
- [ ] Replace `addDocument(agentId, source)` with `ingest({ agentId, source })` and use the new source shape: `{ type, content, metadata? }`.
- [ ] Remove usage of `getConversationHistory(sessionId)` and use your own history when building `messages`.
- [ ] Rename `sessionId` to `threadId` in your code (conceptually the same).
- [ ] Pass `chatModelOptions` (and optionally `goalId`) on every run; do not rely on `llmConfig` or env inside the library.
- [ ] If you had custom tools/skills, either describe their behavior in goal system prompts and use built-in tools only, or extend the worker (e.g. fork or add a way to inject tools) as needed.

---

## 6. Version and docs

- **Package version:** After migrating, depend on `bullmq-ai-agent@^0.2.x` (or the exact version you need).
- **README:** See the main [README.md](./README.md) for the current API, examples, and exports.

If you hit a case not covered here, open an issue with your previous code snippet and the desired behavior so we can extend this guide.

---

## Suggestions for the current version (maintainer)

These are optional improvements you might consider for the refactored codebase:

1. **BullMQAgentWorker.close()** — The README and comments mention a single `close()` to stop all workers, but `BullMQAgentWorker` does not implement `close()`. Adding it would allow graceful shutdown (close Redis client, stop agent/tools/subagents/ingest workers).

2. **Re-export useful types** — Consider exporting `StoredMessage` (from `@langchain/core/messages`) or documenting that callers should use it for `RunOptions.messages`. Exporting `IngestDocument` is already done; ensure `Goal`’s `systemPrompt` type (`SystemMessageFields[]`) is documented or re-exported if needed.

3. **Optional onProgress** — If you want parity with the old `sendPrompt(..., { onProgress })`, you could add an optional `onProgress` to `run`/`runAndWait` (e.g. subscribe to BullMQ job progress and call the callback). Right now progress is only visible inside the worker.

4. **jobRetention / queuePrefix on client** — The old client had `jobRetention` and `queuePrefix`. If you need multi-tenant or custom retention, consider adding these back to `BullMQAgentClient` options.

5. **Document interruptPayload shape** — For human-in-the-loop, document or type the exact shape of `interruptPayload` and what the client should pass to `resume()` so integrators don’t have to guess.
