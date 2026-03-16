import { describe, it, expect, vi, beforeEach } from "vitest";
import { Job } from "bullmq";
import { AgentWorker } from "./agentWorker.js";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { AgentRunData, AgentJobResult, AgentResumeToolData } from "../queues/types.js";
import type { CompiledGraph } from "../agent/compile.js";
import { compileGraph } from "../agent/compile.js";
import { createDefaultAgentWorkerLogger } from "../options.js";
vi.mock("../agent/compile.js");

/** Builds a test job from minimal fields (avoids scattering type casts). */
function mockJob<T>(j: Pick<Job<T, AgentJobResult>, "id" | "name" | "data">): Job<T, AgentJobResult> {
  return j as Job<T, AgentJobResult>;
}

const mockConnection = { url: "redis://localhost" };

const testModelOptions = {
  chatModelOptions: { provider: "openai", model: "gpt-4o-mini", apiKey: "test-key" },
  embeddingModelOptions: { provider: "openai", model: "text-embedding-3-small", apiKey: "test-key" },
};

const mockRedis = {
  eval: vi.fn().mockResolvedValue([]),
  zadd: vi.fn().mockResolvedValue(1),
};

function createMockCompiledGraph(streamResult: { messages?: unknown[]; __interrupt__?: { value: unknown }[] }): CompiledGraph {
  const invoke = vi.fn().mockResolvedValue(streamResult);
  return {
    getRunnable: vi.fn().mockResolvedValue({ invoke }),
    getAgentConfig: undefined,
    getSkillsPrompt: undefined,
  };
}

async function createWorker(compiledGraph: CompiledGraph) {
  vi.mocked(compileGraph).mockResolvedValue(compiledGraph);
  const resolvedGraph = await compileGraph({ tools: [] });
  return new AgentWorker(
    {
      compiledGraph: resolvedGraph,
      redis: mockRedis,
      queueKeyPrefix: "bull",
      chatModelOptions: testModelOptions.chatModelOptions,
      embeddingModelOptions: testModelOptions.embeddingModelOptions,
      logger: createDefaultAgentWorkerLogger(),
    },
    { connection: mockConnection }
  );
}

describe("AgentWorker.processJob", () => {
  beforeEach(() => {
    vi.mocked(compileGraph).mockReset();
    mockRedis.eval.mockResolvedValue([]);
    mockRedis.zadd.mockResolvedValue(1);
  });

  describe("run job", () => {
    const runJob = {
      id: "t1/1700000000000",
      name: "run" as const,
      data: {
        agentId: "default",
        threadId: "t1",
        input: {
          messages: [
            {
              type: "human",
              data: { content: "Hi", name: undefined, tool_call_id: undefined },
            },
          ],
        },
      },
    };

    it("returns final state chunk when graph returns state with AI message", async () => {
      const aiWithToolCall = new AIMessage({ content: "Hello there", tool_calls: [{ id: "tc1", name: "tool", args: {} }] });
      const compiledGraph = createMockCompiledGraph({ messages: [aiWithToolCall] });
      const worker = await createWorker(compiledGraph);
      const result = await worker.processJob(mockJob(runJob));

      expect(result).toBeDefined();
      expect(result.messages).toBeDefined();
      expect(result.messages?.length).toBeGreaterThan(0);
    });

    it("returns final state chunk when graph returns no AI messages", async () => {
      const compiledGraph = createMockCompiledGraph({ messages: [] });
      const worker = await createWorker(compiledGraph);
      const result = await worker.processJob(mockJob(runJob));

      expect(result.messages).toEqual([]);
    });

    it("returns serialized state (messages) when graph returns __interrupt__", async () => {
      const payload = { type: "human", message: "Approve?" };
      const compiledGraph = createMockCompiledGraph({ __interrupt__: [{ value: payload }] });
      const worker = await createWorker(compiledGraph);
      const start = Date.now();
      const result = await worker.processJob(mockJob(runJob));
      const elapsed = Date.now() - start;

      expect(result.messages).toBeDefined();
      expect(Array.isArray(result.messages)).toBe(true);
      expect(elapsed).toBeLessThan(500);
    });

    it("returns serialized state when stream yields __interrupt__", async () => {
      const payload = { type: "human", jobId: "j1" };
      const compiledGraph = createMockCompiledGraph({ __interrupt__: [{ value: payload }] });
      const worker = await createWorker(compiledGraph);
      const result = await worker.processJob(mockJob(runJob));

      expect(result.messages).toBeDefined();
      expect(compiledGraph.getRunnable).toHaveBeenCalledWith(undefined, expect.objectContaining({ provider: "openai", model: "gpt-4o-mini", apiKey: "test-key" }));
    });

    it("rethrows non-GraphInterrupt errors", async () => {
      const runnable = { invoke: vi.fn().mockRejectedValue(new Error("Graph failed")) };
      const compiledGraph = { getRunnable: vi.fn().mockResolvedValue(runnable), getAgentConfig: undefined, getSkillsPrompt: undefined };
      const worker = await createWorker(compiledGraph);
      await expect(worker.processJob(mockJob(runJob))).rejects.toThrow("Graph failed");
    });
  });

  describe("resume job (multiple input messages)", () => {
    it("returns serialized state when graph returns __interrupt__", async () => {
      const runJobMultipleMessages: Pick<Job<AgentRunData, AgentJobResult>, "id" | "name" | "data"> = {
        id: "t1/1700000000001",
        name: "run",
        data: {
          agentId: "default",
          threadId: "t1",
          input: {
            messages: [
              { type: "human", data: { content: "Hi", name: undefined, tool_call_id: undefined } },
              { type: "human", data: { content: "Approved", name: undefined, tool_call_id: undefined } },
            ],
          },
        },
      };
      const payload = { type: "human", jobId: "j2" };
      const compiledGraph = createMockCompiledGraph({ __interrupt__: [{ value: payload }] });
      const worker = await createWorker(compiledGraph);
      const result = await worker.processJob(mockJob(runJobMultipleMessages));

      expect(result.messages).toBeDefined();
    });

    it("passes through StoredToolMessage on resume (caller sends tool message)", async () => {
      const invokeFn = vi.fn().mockResolvedValue({ messages: [] });
      const compiledGraph = {
        getRunnable: vi.fn().mockResolvedValue({ invoke: invokeFn }),
        getAgentConfig: undefined,
        getSkillsPrompt: undefined,
      };
      const resumeJob: Pick<Job<AgentRunData, AgentJobResult>, "id" | "name" | "data"> = {
        id: "t1/1700000000002",
        name: "run",
        data: {
          agentId: "default",
          threadId: "t1",
          input: {
            messages: [
              { type: "human", data: { content: "Ask for approval", name: undefined, tool_call_id: undefined } },
              {
                type: "ai",
                data: {
                  content: "",
                  tool_calls: [{ id: "call_approval_1", name: "request_human_approval", args: { reason: "Proceed?" } }],
                },
              },
              {
                type: "tool",
                data: { content: "Yes, approved", tool_call_id: "call_approval_1", name: "request_human_approval" },
              },
            ],
          },
        },
      };
      const worker = await createWorker(compiledGraph);
      await worker.processJob(mockJob(resumeJob));

      expect(invokeFn).toHaveBeenCalledTimes(1);
      const invokeArg = invokeFn.mock.calls[0][0];
      const messages = invokeArg?.messages ?? [];
      const lastMessage = messages[messages.length - 1];
      expect(ToolMessage.isInstance(lastMessage)).toBe(true);
      expect(lastMessage.tool_call_id).toBe("call_approval_1");
      expect(lastMessage.content).toBe("Yes, approved");
    });
  });

  describe("resumeTool job", () => {
    it("builds tool message from last job return value and runs graph", async () => {
      const lastJobMessages = [
        { type: "human", data: { content: "Ask for approval", name: undefined, tool_call_id: undefined } },
        {
          type: "ai",
          data: {
            content: "",
            tool_calls: [{ id: "call_approval_1", name: "request_human_approval", args: { reason: "Proceed?" } }],
          },
        },
      ];
      const lastJobReturnValue = JSON.stringify({ messages: lastJobMessages });
      vi.mocked(mockRedis.eval).mockResolvedValue(["t1/1700000000001", lastJobReturnValue]);

      const invokeFn = vi.fn().mockResolvedValue({ messages: [] });
      const compiledGraph = {
        getRunnable: vi.fn().mockResolvedValue({ invoke: invokeFn }),
        getAgentConfig: undefined,
        getSkillsPrompt: undefined,
      };
      const resumeToolJob: Pick<Job<AgentResumeToolData, AgentJobResult>, "id" | "name" | "data"> = {
        id: "t1/1700000000002",
        name: "resumeTool",
        data: {
          agentId: "default",
          threadId: "t1",
          content: "Yes, approved",
        },
      };
      const worker = await createWorker(compiledGraph);
      await worker.processJob(mockJob(resumeToolJob));

      expect(invokeFn).toHaveBeenCalledTimes(1);
      const invokeArg = invokeFn.mock.calls[0][0];
      const messages = invokeArg?.messages ?? [];
      const lastMessage = messages[messages.length - 1];
      expect(ToolMessage.isInstance(lastMessage)).toBe(true);
      expect(lastMessage.tool_call_id).toBe("call_approval_1");
      expect(lastMessage.content).toBe("Yes, approved");
      expect(mockRedis.zadd).toHaveBeenCalled();
    });

    it("throws when no previous job for thread", async () => {
      vi.mocked(mockRedis.eval).mockResolvedValue([]);
      const resumeToolJob: Pick<Job<AgentResumeToolData, AgentJobResult>, "id" | "name" | "data"> = {
        id: "t1/1700000000003",
        name: "resumeTool",
        data: { agentId: "default", threadId: "t1", content: "Ok" },
      };
      const compiledGraph = createMockCompiledGraph({ messages: [] });
      const worker = await createWorker(compiledGraph);
      await expect(worker.processJob(mockJob(resumeToolJob))).rejects.toThrow("No previous job found for thread");
    });
  });

  describe("ephemeral subagent", () => {
    it("does not ZADD to thread-jobs when subagent is ephemeral", async () => {
      const compiledGraph = {
        ...createMockCompiledGraph({ messages: [] }),
        isEphemeralSubagent: (id: string) => id === "suggestions",
      };
      const runJob: Pick<Job<AgentRunData, AgentJobResult>, "id" | "name" | "data"> = {
        id: "t1/1700000000099",
        name: "run",
        data: {
          agentId: "default",
          threadId: "t1",
          subagentId: "suggestions",
          input: { messages: [{ type: "human", data: { content: "Hi", name: undefined, tool_call_id: undefined } }] },
        },
      };
      const worker = await createWorker(compiledGraph);
      mockRedis.zadd.mockClear();
      await worker.processJob(mockJob(runJob));
      expect(mockRedis.zadd).not.toHaveBeenCalled();
    });

    it("ZADDs to thread-jobs when subagent is not ephemeral", async () => {
      const compiledGraph = {
        ...createMockCompiledGraph({ messages: [] }),
        isEphemeralSubagent: (id: string) => id === "suggestions",
      };
      const runJob: Pick<Job<AgentRunData, AgentJobResult>, "id" | "name" | "data"> = {
        id: "t1/1700000000100",
        name: "run",
        data: {
          agentId: "default",
          threadId: "t1",
          subagentId: "main-agent",
          input: { messages: [{ type: "human", data: { content: "Hi", name: undefined, tool_call_id: undefined } }] },
        },
      };
      const worker = await createWorker(compiledGraph);
      mockRedis.zadd.mockClear();
      await worker.processJob(mockJob(runJob));
      expect(mockRedis.zadd).toHaveBeenCalledWith("bull:agent:thread-jobs:t1", 1700000000100, "t1/1700000000100");
    });
  });

  describe("interrupts do not hang", () => {
    it("processJob resolves when graph returns __interrupt__ (no hang)", async () => {
      const compiledGraph = createMockCompiledGraph({ __interrupt__: [{ value: { type: "human" } }] });
      const worker = await createWorker(compiledGraph);
      const hangTimeout = 2000;
      const result = await Promise.race([
        worker.processJob(mockJob({
          id: "t-hang-test/1700000000002",
          name: "run",
          data: {
            agentId: "default",
            threadId: "t-hang-test",
            input: {
              messages: [
                {
                  type: "human",
                  data: { content: "x", name: undefined, tool_call_id: undefined },
                },
              ],
            },
          },
        })),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("processJob hung (did not resolve on interrupt)")), hangTimeout)
        ),
      ]);

      expect(result.messages).toBeDefined();
    });
  });
});
