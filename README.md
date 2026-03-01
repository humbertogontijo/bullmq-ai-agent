# bullmq-ai-agent

Scalable AI agent orchestration powered by [BullMQ](https://docs.bullmq.io/) and [LangChain](https://js.langchain.com/).

Define goals and tools, connect any LLM, and let BullMQ handle the rest — parallel execution, persistent sessions, and Redis-backed reliability. Works with a single agent or multiple specialized agents that run concurrently.

## Features

- **Single or Multi-Agent** — one goal runs directly; multiple goals are automatically routed and executed in parallel via BullMQ Flows
- **Provider Agnostic** — works with any LLM supported by LangChain (`openai`, `anthropic`, `google-genai`, etc.)
- **Persistent Sessions** — conversations survive restarts; resume any session from where it left off
- **Human-in-the-loop** — require user approval before executing tool calls; optional live-operator mode via `human_in_the_loop`: operator can tip the agent or send the reply as the agent
- **Job Progress** — optional progress callbacks (prompt-read, thinking, typing, etc.) via BullMQ `job.updateProgress()`
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
  name: 'Flight Finder',
  title: 'Search and book flights to any destination',
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

// Optional: set session config (human-in-the-loop, auto-execute tools). Defaults: both false.
await client.setSessionConfig(sessionId, {
  humanInTheLoop: true,   // Agent can pause and ask the operator for input
  autoExecuteTools: false // Require user confirmation before running tools
});

// Send a prompt (optionally with progress callback)
let result = await client.sendPrompt(sessionId, 'Find flights from SFO to JFK on March 15', {
  onProgress: (p) => console.log(p.phase), // 'prompt-read' | 'thinking' | 'typing' | ...
});

// Human-in-the-loop: when status is 'interrupted', use sendCommand() to resume
if (result.status === 'interrupted' && result.interrupts?.length) {
  const interrupt = result.interrupts[0];

  if (interrupt.type === 'human_input') {
    // Operator tips the agent (agent formulates reply from the tip):
    result = await client.sendCommand(sessionId, {
      type: 'hitl_response',
      response: 'User said: yes, proceed',
    });

    // Or operator sends a reply directly as the agent (no model call):
    result = await client.sendCommand(sessionId, {
      type: 'hitl_direct_reply',
      message: 'Here is the answer.',
    });
  } else {
    // Approve or reject pending tool calls:
    const approved = Object.fromEntries(
      interrupt.actionRequests.map((a) => [a.name, true]),
    );
    result = await client.sendCommand(sessionId, {
      type: 'tool_approval',
      approved,
    });
  }
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

`humanInTheLoop` and `autoExecuteTools` are configured **per session** via `client.setSessionConfig(sessionId, config)` (see below).


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

- `setSessionConfig(sessionId, config): Promise<void>` — Set config for a session. `config: { humanInTheLoop?: boolean, autoExecuteTools?: boolean }`. Call before or at the start of a conversation. The worker reads this when processing jobs for the session.
- `getSessionConfig(sessionId): Promise<Required<SessionConfig>>` — Get current session config (returns defaults when not set).
- `sendPrompt(sessionId, prompt, options?): Promise<StepResult>` — Send a new user message. Options: `attachments` (images, video, audio, or documents — see type `PromptAttachment`), `goalId`, `context`, `initialMessages`, `priority`, `toolChoice`, `sessionConfig`, `onProgress(progress)`. Tool behavior uses session config; pass `sessionConfig` to override for this request only (takes priority over Redis).
- `sendCommand(sessionId, command, options?): Promise<StepResult>` — Resume after status `interrupted`. The `command` is a discriminated union (`ResumeCommand`):
  - `{ type: 'tool_approval', approved: { [toolName]: true | false } }` — approve/reject tools
  - `{ type: 'hitl_response', response: '...' }` — tip the agent (agent formulates reply)
  - `{ type: 'hitl_direct_reply', message: '...' }` — send as the agent (no model call)
- `endChat(sessionId): Promise<StepResult>` — End the conversation
- `getConversationHistory(sessionId): Promise<SerializedMessage[]>` — Get full history
- `close(): Promise<void>` — Close client connections

### `StepResult`

Returned by `sendPrompt`, `sendCommand`, and `endChat`:

```typescript
interface StepResult {
  history: SerializedMessage[];       // New messages from this step
  goalId?: string;                    // Active goal
  status: 'active' | 'interrupted' | 'ended' | 'routing';
  interrupts?: Interrupt[];           // When status is 'interrupted': pending actions
  childrenValues?: Record<string, StepResult>; // Per-agent results (multi-agent mode)
}

interface Interrupt {
  type: 'tool_approval' | 'human_input'; // What kind of interrupt
  actionRequests: ActionRequest[];        // Each has id, name, arguments, description
  goalId?: string;                        // Goal id in multi-goal mode
}
```

### `ResumeCommand`

Discriminated union passed to `sendCommand` to resume after an interrupt:

```typescript
// Approve/reject tools
{ type: 'tool_approval', approved: { SearchFlights: true, BookFlight: false } }

// Reject with feedback
{ type: 'tool_approval', approved: { BookFlight: { approved: false, feedback: 'Too expensive' } } }

// Tip the agent (agent uses this to formulate reply)
{ type: 'hitl_response', response: 'The answer is 42' }

// Send as the agent directly (no model call)
{ type: 'hitl_direct_reply', message: 'Here is your answer.' }
```

### `JobProgress`

When using `onProgress` with `sendPrompt` or `sendCommand`, the callback receives objects of this shape (from BullMQ job progress):

```typescript
interface JobProgress {
  phase: 'prompt-read' | 'routing' | 'thinking' | 'typing' | 'executing-tool' | 'aggregating';
  sessionId?: string;
  goalId?: string;   // present in multi-agent mode
  toolName?: string; // present when phase is 'executing-tool'
}
```

### Utility Functions

- `deriveResponse(messages): string | undefined` — Extract the last AI text response from a message array
- `deriveToolCalls(messages, goalId): ToolCall[]` — Extract pending tool calls from a message array

## LLM Configuration

`llmConfig` is called at the start of each orchestrator/agent step with `{ goalId?, context? }`. Return an object that LangChain's [`initChatModel`](https://js.langchain.com/docs/how_to/chat_models_universal_init/) accepts. Any provider with a `@langchain/*` package works:

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
