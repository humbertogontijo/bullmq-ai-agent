import { describe, it, expect, vi, beforeEach } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
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

describe("createHistoryMiddleware afterAgent", () => {
  it("strips history prefix from state.messages so only delta is returned and not duplicated when saved", () => {
    const mw = createHistoryMiddleware();
    const afterAgent = (mw as { afterAgent?: (s: AgentState) => { messages?: unknown[]; historyMessages?: unknown[] } })
      .afterAgent;
    expect(afterAgent).toBeDefined();

    const historyMsg = new HumanMessage({ content: "old", id: "human1" });
    const currentMsg = new HumanMessage({ content: "new", id: "human2" });
    const aiMsg = new AIMessage({ content: "reply", id: "ai1" });
    const state: AgentState = {
      historyMessages: [historyMsg],
      messages: [historyMsg, currentMsg, aiMsg],
    };
    const result = afterAgent?.(state);
    expect(result?.historyMessages).toEqual([]);
    expect(result?.messages).toHaveLength(3);
    const resultMessages = result?.messages ?? [];
    expect(RemoveMessage.isInstance(resultMessages[0])).toBe(true);
    expect(resultMessages[1]).toBe(currentMsg);
    expect(resultMessages[2]).toBe(aiMsg);
  });

  it("returns REMOVE_ALL_MESSAGES plus empty when state.messages length is <= historyCount", () => {
    const mw = createHistoryMiddleware();
    const afterAgent = (mw as { afterAgent?: (s: AgentState) => { messages?: unknown[]; historyMessages?: unknown[] } })
      .afterAgent;
    const state: AgentState = {
      historyMessages: [new HumanMessage({ content: "h1", id: "human1" }), new HumanMessage({ content: "h2", id: "human2" })],
      messages: [new HumanMessage({ content: "h1", id: "human1" }), new HumanMessage({ content: "h2", id: "human2" })],
    };
    const result = afterAgent?.(state);
    expect(result?.messages).toHaveLength(1);
    expect(RemoveMessage.isInstance((result?.messages ?? [])[0])).toBe(true);
    expect(result?.historyMessages).toEqual([]);
  });

  it("only clears historyMessages when no history was injected", () => {
    const mw = createHistoryMiddleware();
    const afterAgent = (mw as { afterAgent?: (s: AgentState) => { messages?: unknown[]; historyMessages?: unknown[] } })
      .afterAgent;
    const state: AgentState = {
      messages: [new HumanMessage({ content: "only", id: "human1" })],
    };
    const result = afterAgent?.(state);
    expect(result?.historyMessages).toEqual([]);
    expect(result?.messages).toBeUndefined();
  });
});
