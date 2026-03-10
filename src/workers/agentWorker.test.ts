import { describe, it, expect, vi, beforeEach } from "vitest";
import { Job } from "bullmq";
import { AgentWorker } from "./agentWorker.js";
import { AIMessage } from "@langchain/core/messages";
import type { AgentRunData, AgentResumeData, AgentJobResult } from "../queues/types.js";
import { compileGraph } from "../agent/compile.js";
import { createDefaultAgentWorkerLogger } from "../options.js";
import { ResumeWorker } from "./resumeWorker.js";

vi.mock("../agent/compile.js");

const mockConnection = { url: "redis://localhost" };

const testModelOptions = {
  chatModelOptions: { provider: "openai", model: "gpt-4o-mini", apiKey: "test-key" },
  embeddingModelOptions: { provider: "openai", model: "text-embedding-3-small", apiKey: "test-key" },
};

function createMockCompiledGraph(invokeResult: { messages?: unknown[]; __interrupt__?: { value: unknown }[] }) {
  const invoke = vi.fn().mockResolvedValue(invokeResult);
  return {
    getRunnable: vi.fn().mockResolvedValue({ invoke }),
    getAgentConfig: undefined,
    getSkillsPrompt: undefined,
  };
}

async function createWorker(compiledGraph: ReturnType<typeof createMockCompiledGraph>) {
  vi.mocked(compileGraph).mockResolvedValue(compiledGraph as Awaited<ReturnType<typeof compileGraph>>);
  const resolvedGraph = await compileGraph({} as never);
  const resumeWorker = new ResumeWorker({ compiledGraph: resolvedGraph });
  return new AgentWorker(
    {
      compiledGraph: resolvedGraph,
      resumeWorker,
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
  });

  describe("run job", () => {
    const runJob = {
      name: "run" as const,
      data: {
        agentId: "default",
        threadId: "t1",
        input: {
          messages: [
            {
              type: "human",
              data: { content: "Hi", role: "user", name: undefined, tool_call_id: undefined },
            },
          ],
        },
      } satisfies AgentRunData,
    } as Job<AgentRunData, AgentJobResult>;

    it("returns completed with lastMessage when graph returns state with AI message", async () => {
      const aiWithToolCall = new AIMessage({ content: "Hello there", tool_calls: [{ id: "tc1", name: "tool", args: {} }] });
      const compiledGraph = createMockCompiledGraph({ messages: [aiWithToolCall] });
      const worker = await createWorker(compiledGraph);
      const result = await worker.processJob(runJob);

      expect(result).toEqual({ status: "completed", lastMessage: JSON.stringify("Hello there") });
    });

    it("returns completed with undefined lastMessage when graph returns no AI messages", async () => {
      const compiledGraph = createMockCompiledGraph({ messages: [] });
      const worker = await createWorker(compiledGraph);
      const result = await worker.processJob(runJob);

      expect(result).toEqual({ status: "completed", lastMessage: undefined });
    });

    it("returns interrupted with payload when graph returns __interrupt__", async () => {
      const payload = { type: "human", message: "Approve?" };
      const compiledGraph = createMockCompiledGraph({ __interrupt__: [{ value: payload }] });
      const worker = await createWorker(compiledGraph);
      const start = Date.now();
      const result = await worker.processJob(runJob);
      const elapsed = Date.now() - start;

      expect(result.status).toBe("interrupted");
      expect(result.interruptPayload).toMatchObject(payload);
      expect((result.interruptPayload as Record<string, unknown>).subagentId).toBeUndefined();
      expect(elapsed).toBeLessThan(500);
    });

    it("returns interrupted when invoke returns state with __interrupt__", async () => {
      const payload = { type: "human", jobId: "j1" };
      const compiledGraph = createMockCompiledGraph({ __interrupt__: [{ value: payload }] });
      const worker = await createWorker(compiledGraph);
      const result = await worker.processJob(runJob);

      expect(result.status).toBe("interrupted");
      expect(result.interruptPayload).toMatchObject(payload);
      expect(compiledGraph.getRunnable).toHaveBeenCalledWith(undefined, expect.objectContaining({ provider: "openai", model: "gpt-4o-mini", apiKey: "test-key" }));
    });

    it("rethrows non-GraphInterrupt errors", async () => {
      const runnable = { invoke: vi.fn().mockRejectedValue(new Error("Graph failed")) };
      const compiledGraph = { getRunnable: vi.fn().mockResolvedValue(runnable), getAgentConfig: undefined, getSkillsPrompt: undefined };
      const worker = await createWorker(compiledGraph);
      await expect(worker.processJob(runJob)).rejects.toThrow("Graph failed");
    });
  });

  describe("resume job", () => {
    const resumeJob = {
      name: "resume" as const,
      data: {
        agentId: "default",
        threadId: "t1",
        result: { content: "Approved" },
      } satisfies AgentResumeData,
    } as Job<AgentResumeData, AgentJobResult>;

    it("returns completed with lastMessage when resume completes", async () => {
      const aiMessage = new AIMessage({ content: "Done." });
      const compiledGraph = createMockCompiledGraph({ messages: [aiMessage] });
      const worker = await createWorker(compiledGraph);
      const result = await worker.processJob(resumeJob);

      expect(result).toEqual({ status: "completed", lastMessage: JSON.stringify("Done.") });
    });

    it("returns interrupted when resume invoke returns __interrupt__", async () => {
      const payload = { type: "human", jobId: "j2" };
      const compiledGraph = createMockCompiledGraph({ __interrupt__: [{ value: payload }] });
      const worker = await createWorker(compiledGraph);
      const start = Date.now();
      const result = await worker.processJob(resumeJob);
      const elapsed = Date.now() - start;

      expect(result).toEqual({ status: "interrupted", interruptPayload: payload });
      expect(elapsed).toBeLessThan(500);
    });
  });

  describe("interrupts do not hang", () => {
    it("processJob resolves when graph returns __interrupt__ (no hang)", async () => {
      const compiledGraph = createMockCompiledGraph({ __interrupt__: [{ value: { type: "human" } }] });
      const worker = await createWorker(compiledGraph);
      const hangTimeout = 2000;
      const result = await Promise.race([
        worker.processJob({
          name: "run",
          data: {
            agentId: "default",
            threadId: "t-hang-test",
            input: {
              messages: [
                {
                  type: "human",
                  data: { content: "x", role: "user", name: undefined, tool_call_id: undefined },
                },
              ],
            },
          },
        } as Job<AgentRunData, AgentJobResult>),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("processJob hung (did not resolve on interrupt)")), hangTimeout)
        ),
      ]);

      expect(result.status).toBe("interrupted");
    });
  });
});
