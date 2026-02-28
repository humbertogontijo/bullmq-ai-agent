# bullmq-ai-agent

Scalable AI agent orchestration powered by [BullMQ](https://docs.bullmq.io/) and [LangChain](https://js.langchain.com/).

Define goals and tools, connect any LLM, and let BullMQ handle the rest — parallel execution, persistent sessions, and Redis-backed reliability. Works with a single agent or multiple specialized agents that run concurrently.

## Features

- **Single or Multi-Agent** — one goal runs directly; multiple goals are automatically routed and executed in parallel via BullMQ Flows
- **Provider Agnostic** — works with any LLM supported by LangChain (`openai`, `anthropic`, `google-genai`, etc.)
- **Persistent Sessions** — conversations survive restarts; resume any session from where it left off
- **Tool Confirmation** — optionally require user approval before executing tool calls
- **Redis-Backed** — all state lives in Redis via BullMQ; no additional database needed
- **Type-Safe Tools** — define tool schemas with [TypeBox](https://github.com/sinclairzx81/typebox) for full type inference

## How It Works

```
┌─────────┐    prompt     ┌──────────────┐
│  Client  │─────────────▶│ Orchestrator │
└─────────┘               │   (BullMQ)   │
     ▲                    └──────┬───────┘
     │                           │
     │    result           ┌─────┴─────┐
     │◀────────────────────┤  Router /  │
     │                     │  Direct    │
     │                     └─────┬─────┘
     │                           │
     │              ┌────────────┼────────────┐
     │              ▼            ▼             ▼
     │         ┌─────────┐ ┌─────────┐  ┌─────────┐
     │         │ Agent A  │ │ Agent B  │  │ Agent C  │
     │         │ (tools)  │ │ (tools)  │  │ (tools)  │
     │         └────┬─────┘ └────┬─────┘  └────┬─────┘
     │              │            │              │
     │              └────────────┼──────────────┘
     │                           ▼
     │                     ┌───────────┐
     └─────────────────────┤ Aggregator│
                           └───────────┘
```

**Single-agent mode:** The orchestrator processes the prompt directly — no routing or aggregation overhead.

**Multi-agent mode:** An LLM-powered router selects which agents should handle the request. Selected agents run in parallel as BullMQ child jobs, and an aggregator collects their results.

## Installation

```bash
npm install bullmq-ai-agent
```

Install a LangChain provider for your LLM of choice:

```bash
# Pick one (or more)
npm install @langchain/openai
npm install @langchain/anthropic
npm install @langchain/google-genai
```

You'll also need a running Redis instance. [Redis docs](https://redis.io/docs/getting-started/) or:

```bash
docker run -d --name redis -p 6379:6379 redis
```

## Quick Start

### 1. Define Tools

Tools use [TypeBox](https://github.com/sinclairzx81/typebox) schemas for type-safe argument validation:

```typescript
import { Type } from '@sinclair/typebox';
import type { AgentTool } from 'bullmq-ai-agent';

const SearchFlightsSchema = Type.Object({
  origin: Type.String({ description: 'Origin airport code (e.g. SFO)' }),
  destination: Type.String({ description: 'Destination airport code (e.g. JFK)' }),
  date: Type.String({ description: 'Travel date in YYYY-MM-DD format' }),
});

const searchFlights: AgentTool<typeof SearchFlightsSchema> = {
  name: 'SearchFlights',
  description: 'Search for available flights between two airports on a given date',
  schema: SearchFlightsSchema,
  handler: async (args) => {
    // args is fully typed: { origin: string, destination: string, date: string }
    const flights = await yourFlightAPI.search(args);
    return { flights };
  },
};
```

### 2. Define Goals

A goal groups related tools under a name and description that the LLM uses to understand its purpose:

```typescript
import type { AgentGoal } from 'bullmq-ai-agent';

const flightGoal: AgentGoal = {
  id: 'flight-booking',
  agentName: 'Flight Finder',
  agentFriendlyDescription: 'Search and book flights to any destination',
  description:
    'Help the user find and book flights. ' +
    '1. Use SearchFlights to find available options. ' +
    '2. Use BookFlight to book the chosen flight.',
  tools: [searchFlights, bookFlight],
};
```

### 3. Start the Worker

```typescript
import { AgentWorker } from 'bullmq-ai-agent';

const worker = new AgentWorker({
  connection: { host: 'localhost', port: 6379 },
  llmConfig: async () => ({
    model: 'openai:gpt-4o',
    apiKey: process.env.OPENAI_API_KEY,
  }),
  goals: [flightGoal],
});

await worker.start();
```

### 4. Chat with the Agent

```typescript
import { AgentClient } from 'bullmq-ai-agent';

const client = new AgentClient({
  connection: { host: 'localhost', port: 6379 },
});

const sessionId = 'user-123';

// Send a prompt
let result = await client.sendPrompt(sessionId, 'Find flights from SFO to JFK on March 15');

// If the agent wants to call a tool (confirmation is always required)
if (result.status === 'awaiting-confirm') {
  // Inspect result.toolCalls, then approve:
  result = await client.confirm(sessionId);
}

// Retrieve full conversation history (survives restarts)
const history = await client.getConversationHistory(sessionId);
```

## Multi-Agent Mode

Pass multiple goals and the orchestrator automatically routes each prompt to the right agent(s):

```typescript
const worker = new AgentWorker({
  connection: { host: 'localhost', port: 6379 },
  llmConfig: async () => ({
    model: 'openai:gpt-4o',
    apiKey: process.env.OPENAI_API_KEY,
  }),
  goals: [flightGoal, hrGoal, expenseGoal], // 2+ goals enables multi-agent mode
});
```

When a user sends "Book a flight to NYC and check my PTO balance", the orchestrator dispatches both the flight and HR agents in parallel. Results are aggregated and returned together.

## API Reference

### `AgentWorker`

The server-side component that processes jobs.

```typescript
new AgentWorker(options: AgentWorkerOptions)
```


| Option              | Type                | Description                                                       |
| ------------------- | ------------------- | ----------------------------------------------------------------- |
| `connection`        | `ConnectionOptions` | Redis connection (from BullMQ)                                    |
| `llmConfig`        | `(options) => Promise<AgentWorkerLlmConfigData>` | Called each step; return config for `initChatModel` (model, apiKey, etc.) |
| `goals`             | `AgentGoal[]`       | One or more agent goals with tools                                |


**Methods:**

- `start(): Promise<void>` — Start processing jobs
- `close(): Promise<void>` — Gracefully shut down all workers

### `AgentClient`

The client-side component for sending prompts and managing sessions.

```typescript
new AgentClient(options: AgentClientOptions)
```


| Option         | Type                | Description                                              |
| -------------- | ------------------- | -------------------------------------------------------- |
| `connection`   | `ConnectionOptions` | Redis connection (from BullMQ)                           |
| `jobRetention` | `JobRetention?`     | How long to keep completed jobs (default: 1h / 200 jobs) |


**Methods:**

- `sendPrompt(sessionId, prompt, options?): Promise<StepResult>` — Send a user message. Options: `goalId`, `context`, `initialMessages`, `priority`, `toolChoice`, `autoExecuteTools` (when `true`, tools run automatically; when omitted or false, user confirmation is required).
- `confirm(sessionId, context?): Promise<StepResult>` — Approve pending tool calls
- `endChat(sessionId): Promise<StepResult>` — End the conversation
- `getConversationHistory(sessionId): Promise<SerializedMessage[]>` — Get full history
- `close(): Promise<void>` — Close client connections

### `StepResult`

Returned by `sendPrompt`, `confirm`, and `endChat`:

```typescript
interface StepResult {
  history: SerializedMessage[];       // New messages from this step
  goalId?: string;                    // Active goal (single-agent mode)
  toolCalls?: ToolCall[];             // Pending tool calls (when awaiting-confirm)
  agentResults?: Record<string, AgentChildResult>; // Per-agent results (multi-agent mode)
  status: 'active' | 'awaiting-confirm' | 'ended' | 'routing';
}
```

### Utility Functions

- `deriveResponse(messages): string | undefined` — Extract the last AI text response from a message array
- `deriveToolCalls(messages, goalId): ToolCall[]` — Extract pending tool calls from a message array

## LLM Configuration

`llmConfig` is called at the start of each orchestrator/agent step with `{ goalId?, context? }`. Return an object that LangChain's `[initChatModel](https://js.langchain.com/docs/how_to/chat_models_universal_init/)` accepts. Any provider with a `@langchain/*` package works:

```typescript
// Static config (same for every step)
llmConfig: async () => ({
  model: 'openai:gpt-4o',
  apiKey: process.env.OPENAI_API_KEY,
})

// Per-goal or per-request
llmConfig: async ({ goalId, context }) => ({
  model: goalId === 'hr-pto' ? 'anthropic:claude-3-5-sonnet' : 'openai:gpt-4o',
  apiKey: process.env.OPENAI_API_KEY,
  temperature: context?.temperature ?? 0.2,
})
```

### Explicit goal and session history

When you pass `goalId` to `sendPrompt`, the worker runs that goal in **single-goal mode**: the orchestrator runs the agent directly and stores the step in the orchestrator queue (no routing, no flow). That keeps behavior consistent when you pin a conversation to one goal.

Session history is always built from **both** the orchestrator and aggregator queues. So if you switch between single-goal (or explicit `goalId`) and multi-goal routing in the same session, you do not lose history: the worker merges prior single-goal steps and prior multi-goal steps for the current goal when building the message list for the LLM.

## Examples

The repository includes runnable examples:

```bash
# Single agent — flight booking
npx tsx examples/single-agent.ts

# Multi-agent — flight booking + HR assistant
npx tsx examples/multi-agent.ts
```

Both examples feature a CLI chat interface with conversation history that persists across restarts.

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## Support

If you find this project useful, consider [buying me a coffee](https://buymeacoffee.com/humbertogontijo).

## License

[MIT](LICENSE)