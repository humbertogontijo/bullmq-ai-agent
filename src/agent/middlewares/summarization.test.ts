import { describe, it, expect, vi, beforeEach } from "vitest";
import { HumanMessage, RemoveMessage, SystemMessage } from "@langchain/core/messages";
import { createSummarizationMiddleware, DEFAULT_SUMMARIZE_WHEN_HISTORY_LONGER_THAN } from "./summarization.js";
import type { RunContext } from "../../options.js";

const { mockInvoke, mockInitChatModel } = vi.hoisted(() => {
  const invoke = vi.fn().mockResolvedValue({ content: "Fake summary of the conversation." });
  return {
    mockInvoke: invoke,
    mockInitChatModel: vi.fn().mockResolvedValue({ invoke }),
  };
});

vi.mock("langchain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("langchain")>();
  return {
    ...actual,
    initChatModel: mockInitChatModel,
  };
});

describe("createSummarizationMiddleware", () => {
  const mockEval = vi.fn().mockResolvedValue(3);
  const mockZadd = vi.fn().mockResolvedValue(1);
  const redis: RunContext["redis"] = { eval: mockEval, zadd: mockZadd };
  const runContext: RunContext = {
    job: {} as RunContext["job"],
    agentId: "test",
    thread_id: "thread-1",
    queueKeyPrefix: "bull",
    chatModelOptions: {
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "test-key",
    },
    redis,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue({ content: "Fake summary of the conversation." });
    mockEval.mockResolvedValue(3);
  });

  it("exposes DEFAULT_SUMMARIZE_WHEN_HISTORY_LONGER_THAN", () => {
    expect(DEFAULT_SUMMARIZE_WHEN_HISTORY_LONGER_THAN).toBe(50);
  });

  it("returns middleware with beforeAgent", () => {
    const middleware = createSummarizationMiddleware();
    expect(middleware).toBeDefined();
    const ba = middleware.beforeAgent;
    expect(ba !== undefined && (typeof ba === "function" || typeof (ba as { hook?: unknown }).hook === "function")).toBe(true);
  });

  function callBeforeAgent(
    middleware: ReturnType<typeof createSummarizationMiddleware>,
    state: unknown,
    runtime: { context: RunContext }
  ): Promise<unknown> {
    const ba = middleware.beforeAgent;
    if (typeof ba === "function") return ba(state, runtime);
    return (ba as { hook: (s: unknown, r: unknown) => Promise<unknown> }).hook(state, runtime);
  }

  it("does nothing when context is missing redis", async () => {
    const middleware = createSummarizationMiddleware({ summarizeWhenHistoryLongerThan: 2 });
    const state = { historyMessages: [new HumanMessage("Hi"), new HumanMessage("Bye")] };
    const runtime = { context: { ...runContext, redis: undefined } };

    const result = await callBeforeAgent(middleware, state, runtime);

    expect(result).toBeUndefined();
    expect(mockInitChatModel).not.toHaveBeenCalled();
    expect(mockEval).not.toHaveBeenCalled();
  });

  it("does nothing when context is missing thread_id", async () => {
    const middleware = createSummarizationMiddleware({ summarizeWhenHistoryLongerThan: 2 });
    const state = { historyMessages: [new HumanMessage("Hi"), new HumanMessage("Bye")] };
    const runtime = { context: { ...runContext, thread_id: undefined } };

    const result = await callBeforeAgent(middleware, state, runtime);

    expect(result).toBeUndefined();
    expect(mockInitChatModel).not.toHaveBeenCalled();
    expect(mockEval).not.toHaveBeenCalled();
  });

  it("does nothing when context is missing chatModelOptions", async () => {
    const middleware = createSummarizationMiddleware({ summarizeWhenHistoryLongerThan: 2 });
    const state = { historyMessages: [new HumanMessage("Hi"), new HumanMessage("Bye")] };
    const runtime = { context: { ...runContext, chatModelOptions: undefined } };

    const result = await callBeforeAgent(middleware, state, runtime);

    expect(result).toBeUndefined();
    expect(mockInitChatModel).not.toHaveBeenCalled();
    expect(mockEval).not.toHaveBeenCalled();
  });

  it("does nothing when historyMessages length is below threshold", async () => {
    const middleware = createSummarizationMiddleware({ summarizeWhenHistoryLongerThan: 3 });
    const state = { historyMessages: [new HumanMessage("Hi"), new HumanMessage("Bye")] };
    const runtime = { context: runContext };

    const result = await callBeforeAgent(middleware, state, runtime);

    expect(result).toBeUndefined();
    expect(mockInitChatModel).not.toHaveBeenCalled();
    expect(mockEval).not.toHaveBeenCalled();
  });

  it("does nothing when historyMessages is empty", async () => {
    const middleware = createSummarizationMiddleware({ summarizeWhenHistoryLongerThan: 2 });
    const state = { historyMessages: [] };
    const runtime = { context: runContext };

    const result = await callBeforeAgent(middleware, state, runtime);

    expect(result).toBeUndefined();
    expect(mockInitChatModel).not.toHaveBeenCalled();
    expect(mockEval).not.toHaveBeenCalled();
  });

  it("when historyMessages meets threshold: calls initChatModel, invokes with summarization prompt, runs clear script, returns historyMessages empty and messages with summary", async () => {
    const middleware = createSummarizationMiddleware({ summarizeWhenHistoryLongerThan: 2 });
    const state = {
      historyMessages: [
        new HumanMessage("What is the weather?"),
        new HumanMessage("Tell me more about that."),
      ],
    };
    const runtime = { context: runContext };

    const result = await callBeforeAgent(middleware, state, runtime);

    expect(mockInitChatModel).toHaveBeenCalledWith("openai:gpt-4o-mini", {
      apiKey: "test-key",
      temperature: 0,
      maxTokens: 2048,
    });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const messages = mockInvoke.mock.calls[0][0];
    expect(Array.isArray(messages)).toBe(true);
    // [system, human prompt, ...historyMessages]
    expect(messages).toHaveLength(4);
    expect(messages[0]).toBeInstanceOf(SystemMessage);
    const m1 = messages[1];
    const m2 = messages[2];
    const m3 = messages[3];
    expect(HumanMessage.isInstance(m1)).toBe(true);
    expect(HumanMessage.isInstance(m2)).toBe(true);
    expect(HumanMessage.isInstance(m3)).toBe(true);
    if (HumanMessage.isInstance(m1) && HumanMessage.isInstance(m2) && HumanMessage.isInstance(m3)) {
      expect(String(m1.content)).toContain("Summarize the following conversation");
      expect(String(m2.content)).toBe("What is the weather?");
      expect(String(m3.content)).toBe("Tell me more about that.");
    }

    expect(mockEval).toHaveBeenCalledTimes(1);
    expect(mockEval).toHaveBeenCalledWith(
      expect.any(String),
      2,
      "bull:agent:thread-jobs:thread-1",
      "bull:agent:completed",
      "bull:agent:"
    );

    expect(result?.historyMessages).toEqual([]);
    expect(result?.messages).toHaveLength(2);
    expect(RemoveMessage.isInstance(result?.messages?.[0])).toBe(true);
    expect(result?.messages?.[1]).toEqual(
      new SystemMessage("[Previous conversation summary]\nFake summary of the conversation.")
    );
  });

  it("uses custom threshold when summarizeWhenHistoryLongerThan is passed", async () => {
    const middleware = createSummarizationMiddleware({ summarizeWhenHistoryLongerThan: 1 });
    const state = { historyMessages: [new HumanMessage("Only one")] };
    const runtime = { context: runContext };

    const result = await callBeforeAgent(middleware, state, runtime);

    expect(mockInitChatModel).toHaveBeenCalled();
    expect(mockEval).toHaveBeenCalled();
    expect(result).toBeDefined();
    expect(result?.historyMessages).toEqual([]);
    expect(result?.messages).toHaveLength(2);
    expect(RemoveMessage.isInstance(result?.messages?.[0])).toBe(true);
    const sysMsg = result?.messages?.[1];
    expect(SystemMessage.isInstance(sysMsg)).toBe(true);
    if (SystemMessage.isInstance(sysMsg)) {
      expect(sysMsg.content).toContain("Fake summary");
    }
  });
});
