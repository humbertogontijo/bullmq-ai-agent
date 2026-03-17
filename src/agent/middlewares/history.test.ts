import { describe, it, expect, vi, beforeEach } from "vitest";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { RemoveMessage } from "@langchain/core/messages";
import {
  createHistoryMiddleware,
  parseTimestampFromJobId,
  getThreadHistoryMessages,
  serializeAgentState,
} from "./history.js";
import type { AgentState } from "../state.js";
import type { RedisWithEval } from "./history.js";

const mockEvalFn = vi.fn().mockResolvedValue([]);
const mockRedis: RedisWithEval = {
  eval: mockEvalFn as RedisWithEval["eval"],
};

describe("parseTimestampFromJobId", () => {
  it("extracts timestamp from threadId/timestamp", () => {
    expect(parseTimestampFromJobId("t1/1700000000000")).toBe(1700000000000);
    expect(parseTimestampFromJobId("thread-abc/123")).toBe(123);
  });
  it("returns NaN when no slash", () => {
    expect(parseTimestampFromJobId("t1")).toBeNaN();
    expect(parseTimestampFromJobId("")).toBeNaN();
  });
  it("returns NaN when timestamp is not a number", () => {
    expect(parseTimestampFromJobId("t1/foo")).toBeNaN();
  });
});

describe("createHistoryMiddleware beforeAgent", () => {
  beforeEach(() => {
    mockEvalFn.mockResolvedValue([]);
  });

  it("passes maxHistoryMessages to getPreviousReturnvalues Lua as max jobs limit", async () => {
    const twoJobReturnValues = [
      JSON.stringify({ messages: [{ type: "human", data: { content: "1", name: undefined, tool_call_id: undefined } }] }),
      JSON.stringify({ messages: [{ type: "human", data: { content: "1", name: undefined, tool_call_id: undefined } }, { type: "ai", data: { content: "2", tool_calls: [] } }] }),
    ];
    mockEvalFn.mockResolvedValue(twoJobReturnValues);

    const mw = createHistoryMiddleware();
    const beforeAgent = (mw as { beforeAgent?: (s: unknown, r: { context?: unknown }) => Promise<{ historyMessages?: unknown[] }> }).beforeAgent;
    expect(beforeAgent).toBeDefined();

    const runtime = {
      context: {
        redis: mockRedis,
        thread_id: "t1",
        job: { id: "t1/400" },
        queueKeyPrefix: "bull",
        maxHistoryMessages: 2,
      },
    };
    const result = await beforeAgent?.({}, runtime);
    expect(result?.historyMessages).toBeDefined();
    expect(mockEvalFn).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "bull:agent:thread-jobs:t1",
      "400",
      "bull:agent:",
      "2"
    );
    expect(result!.historyMessages!.length).toBe(3);
  });
});

describe("getThreadHistoryMessages", () => {
  beforeEach(() => {
    mockEvalFn.mockResolvedValue([]);
  });

  it("calls eval with thread-jobs key (threadId only), current_ts, prefix, and max jobs (default 500)", async () => {
    await getThreadHistoryMessages(
      mockRedis,
      "t1",
      "t1/300",
      "bull",
    );
    expect(mockEvalFn).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "bull:agent:thread-jobs:t1",
      "300",
      "bull:agent:",
      "500",
    );
  });

  it("calls eval with custom maxJobs when provided", async () => {
    await getThreadHistoryMessages(
      mockRedis,
      "t1",
      "t1/300",
      "bull",
      10,
    );
    expect(mockEvalFn).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "bull:agent:thread-jobs:t1",
      "300",
      "bull:agent:",
      "10",
    );
  });
});

describe("serializeAgentState", () => {
  it("returns messages from __interrupt__ value when state has __interrupt__ with nested AgentState", () => {
    const interruptValue: AgentState = {
      messages: [
        new HumanMessage({ content: "Hello", id: "human1" }),
        new AIMessage({
          content: "reply",
          id: "ai1",
          tool_calls: [
            { id: "tc1", name: "escalate_to_human", args: { reason: "Customer requested human", context: { ticketId: "T1" } } },
          ],
        }),
      ],
    };
    const state: AgentState = {
      messages: [new HumanMessage({ content: "Hello", id: "human1" })],
      __interrupt__: [{ value: interruptValue }],
    };
    const result = serializeAgentState(state);
    expect(result.messages).toHaveLength(2);
  });

  it("returns only messages when no __interrupt__", () => {
    const state: AgentState = {
      messages: [new HumanMessage({ content: "Hi", id: "human1" })],
    };
    const result = serializeAgentState(state);
    expect(result.messages).toHaveLength(1);
  });
});

type MiddlewareHooks = {
  beforeAgent?: (s: unknown, r: { context?: unknown }) => Promise<{ historyMessages?: unknown[] }>;
  beforeModel?: (s: Record<string, unknown>) => Promise<{ messages?: unknown[] }>;
  afterModel?: (s: Record<string, unknown>) => { messages?: unknown[] };
};

describe("createHistoryMiddleware beforeModel", () => {
  it("injects history between system messages and current messages", async () => {
    const mw = createHistoryMiddleware() as MiddlewareHooks;

    const sysMsg = new SystemMessage({ content: "You are helpful", id: "sys1" });
    const historyHuman = new HumanMessage({ content: "old question", id: "hist1" });
    const historyAi = new AIMessage({ content: "old answer", id: "hist2" });
    const currentMsg = new HumanMessage({ content: "new question", id: "h1" });

    const state = {
      historyMessages: [historyHuman, historyAi],
      messages: [sysMsg, currentMsg],
    };

    const result = await mw.beforeModel!(state);
    const msgs = result.messages!;

    expect(RemoveMessage.isInstance(msgs[0])).toBe(true);
    expect(SystemMessage.isInstance(msgs[1])).toBe(true);
    expect((msgs[1] as SystemMessage).content).toBe("You are helpful");
    expect((msgs[2] as HumanMessage).content).toBe("old question");
    expect((msgs[3] as AIMessage).content).toBe("old answer");
    expect((msgs[4] as HumanMessage).content).toBe("new question");
    expect(msgs).toHaveLength(5);
  });

  it("works when there are no history messages", async () => {
    const mw = createHistoryMiddleware() as MiddlewareHooks;

    const currentMsg = new HumanMessage({ content: "hello", id: "h1" });
    const state = {
      historyMessages: [],
      messages: [currentMsg],
    };

    const result = await mw.beforeModel!(state);
    const msgs = result.messages!;

    expect(RemoveMessage.isInstance(msgs[0])).toBe(true);
    expect((msgs[1] as HumanMessage).content).toBe("hello");
    expect(msgs).toHaveLength(2);
  });

  it("works when historyMessages is undefined", async () => {
    const mw = createHistoryMiddleware() as MiddlewareHooks;

    const currentMsg = new HumanMessage({ content: "hi", id: "h1" });
    const state = {
      messages: [currentMsg],
    };

    const result = await mw.beforeModel!(state);
    const msgs = result.messages!;

    expect(RemoveMessage.isInstance(msgs[0])).toBe(true);
    expect((msgs[1] as HumanMessage).content).toBe("hi");
    expect(msgs).toHaveLength(2);
  });

  it("places multiple system messages before history", async () => {
    const mw = createHistoryMiddleware() as MiddlewareHooks;

    const sys1 = new SystemMessage({ content: "sys1", id: "s1" });
    const sys2 = new SystemMessage({ content: "sys2", id: "s2" });
    const historyMsg = new HumanMessage({ content: "old", id: "hist1" });
    const currentMsg = new HumanMessage({ content: "new", id: "h1" });

    const state = {
      historyMessages: [historyMsg],
      messages: [sys1, currentMsg, sys2],
    };

    const result = await mw.beforeModel!(state);
    const msgs = result.messages!;

    expect(RemoveMessage.isInstance(msgs[0])).toBe(true);
    expect(SystemMessage.isInstance(msgs[1])).toBe(true);
    expect(SystemMessage.isInstance(msgs[2])).toBe(true);
    expect((msgs[3] as HumanMessage).content).toBe("old");
    expect((msgs[4] as HumanMessage).content).toBe("new");
    expect(msgs).toHaveLength(5);
  });
});

describe("createHistoryMiddleware afterModel", () => {
  it("returns RemoveMessage for each history message", () => {
    const mw = createHistoryMiddleware() as MiddlewareHooks;

    const hist1 = new HumanMessage({ content: "old1", id: "hist1" });
    const hist2 = new AIMessage({ content: "old2", id: "hist2" });

    const state = {
      historyMessages: [hist1, hist2],
      messages: [],
    };

    const result = mw.afterModel!(state);
    const msgs = result.messages!;

    expect(msgs).toHaveLength(2);
    expect(RemoveMessage.isInstance(msgs[0])).toBe(true);
    expect(RemoveMessage.isInstance(msgs[1])).toBe(true);
    expect((msgs[0] as RemoveMessage).id).toBe("hist1");
    expect((msgs[1] as RemoveMessage).id).toBe("hist2");
  });

  it("returns empty messages when no history was injected", () => {
    const mw = createHistoryMiddleware() as MiddlewareHooks;

    const state = {
      historyMessages: [],
      messages: [new HumanMessage({ content: "current", id: "h1" })],
    };

    const result = mw.afterModel!(state);
    expect(result.messages).toHaveLength(0);
  });

  it("returns empty messages when historyMessages is undefined", () => {
    const mw = createHistoryMiddleware() as MiddlewareHooks;

    const state = {
      messages: [new HumanMessage({ content: "current", id: "h1" })],
    };

    const result = mw.afterModel!(state);
    expect(result.messages).toHaveLength(0);
  });
});
