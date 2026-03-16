import { describe, it, expect } from "vitest";
import { getLastRequestHumanApprovalToolCall, isResumeRequired } from "./message.js";
import type { StoredMessage, StoredAgentState } from "../queues/types.js";

const humanMsg: StoredMessage = {
  type: "human",
  data: { content: "Hi", name: undefined, tool_call_id: undefined },
};
const aiMsgNoToolCalls: StoredMessage = {
  type: "ai",
  data: { content: "Hello", name: undefined, tool_calls: [] },
};
const aiMsgWithHitl: StoredMessage = {
  type: "ai",
  data: {
    content: "",
    name: undefined,
    tool_calls: [{ id: "call_1", name: "request_human_approval", args: { reason: "Approve?" } }],
  },
};
const aiMsgOtherTool: StoredMessage = {
  type: "ai",
  data: {
    content: "",
    name: undefined,
    tool_calls: [{ id: "call_2", name: "search_knowledge", args: {} }],
  },
};

describe("getLastRequestHumanApprovalToolCall", () => {
  it("returns tool call object when last AI message has request_human_approval", () => {
    const result = getLastRequestHumanApprovalToolCall([humanMsg, aiMsgWithHitl]);
    expect(result).toEqual({ id: "call_1", name: "request_human_approval", args: { reason: "Approve?" } });
  });
  it("returns undefined when last AI message has no tool_calls or messages is empty", () => {
    expect(getLastRequestHumanApprovalToolCall([humanMsg, aiMsgNoToolCalls])).toBeUndefined();
    expect(getLastRequestHumanApprovalToolCall([])).toBeUndefined();
  });
  it("returns first tool call of last AI message when it has other tool (e.g. search_knowledge)", () => {
    const result = getLastRequestHumanApprovalToolCall([humanMsg, aiMsgOtherTool]);
    expect(result).toEqual({ id: "call_2", name: "search_knowledge", args: {} });
  });
  it("returns first tool call from last AI message with request_human_approval when multiple", () => {
    const aiSecondHitl: StoredMessage = {
      type: "ai",
      data: {
        content: "",
        name: undefined,
        tool_calls: [{ id: "call_last", name: "request_human_approval", args: {} }],
      },
    };
    const result = getLastRequestHumanApprovalToolCall([humanMsg, aiMsgWithHitl, humanMsg, aiSecondHitl]);
    expect(result).toEqual({ id: "call_last", name: "request_human_approval", args: {} });
  });
});

describe("isResumeRequired", () => {
  it("returns true when last message is AI with request_human_approval tool call", () => {
    const chunk: StoredAgentState = { messages: [humanMsg, aiMsgWithHitl] };
    expect(isResumeRequired(chunk)).toBe(true);
  });
  it("returns false when last message is not AI", () => {
    const chunk: StoredAgentState = { messages: [aiMsgWithHitl, humanMsg] };
    expect(isResumeRequired(chunk)).toBe(false);
  });
  it("returns false when last message is AI but has no tool_calls", () => {
    const chunk: StoredAgentState = { messages: [humanMsg, aiMsgNoToolCalls] };
    expect(isResumeRequired(chunk)).toBe(false);
  });
  it("returns true when last message is AI with any tool_calls (e.g. search_knowledge)", () => {
    const chunk: StoredAgentState = { messages: [humanMsg, aiMsgOtherTool] };
    expect(isResumeRequired(chunk)).toBe(true);
  });
  it("returns false when messages is empty or chunk is empty", () => {
    expect(isResumeRequired({ messages: [] })).toBe(false);
    expect(isResumeRequired({ messages: [] })).toBe(false);
  });
  it("returns false when chunk is null/undefined (uses optional chaining)", () => {
    expect(isResumeRequired(null)).toBe(false);
    expect(isResumeRequired(undefined)).toBe(false);
  });
});

