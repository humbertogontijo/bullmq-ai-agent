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

async function createWorker() {
  const compiledGraph = await compileGraph({} as any);
  const resumeWorker = new ResumeWorker({ compiledGraph });
  return new AgentWorker(
    {
      compiledGraph,
      resumeWorker,
      embeddingModelOptions: testModelOptions.embeddingModelOptions,
      logger: createDefaultAgentWorkerLogger(),
    },
    { connection: mockConnection }
  );
}

const testModelOptions = {
  chatModelOptions: { provider: "openai", model: "gpt-4o-mini", apiKey: "test-key" },
  embeddingModelOptions: { provider: "openai", model: "text-embedding-3-small", apiKey: "test-key" },
};

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
        chatModelOptions: testModelOptions.chatModelOptions,
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
      // getLastAIMessage returns only AI messages with tool_calls; plain reply yields undefined lastMessage
      const aiWithToolCall = new AIMessage({ content: "Hello there", tool_calls: [{ id: "tc1", name: "tool", args: {} }] });
      vi.mocked(compileGraph).mockResolvedValue({
        invoke: vi.fn().mockResolvedValue({
          messages: [aiWithToolCall],
        }),
      } as any);

      const worker = await createWorker();
      const result = await worker.processJob(runJob);

      expect(result).toEqual({ status: "completed", lastMessage: JSON.stringify("Hello there") });
    });

    it("returns completed with undefined lastMessage when graph returns no AI messages", async () => {
      vi.mocked(compileGraph).mockResolvedValue({
        invoke: vi.fn().mockResolvedValue({ messages: [] }),
      } as any);

      const worker = await createWorker();
      const result = await worker.processJob(runJob);

      expect(result).toEqual({ status: "completed", lastMessage: undefined });
    });

    it("returns interrupted with payload when graph returns __interrupt__", async () => {
      const payload = { type: "human", message: "Approve?" };
      vi.mocked(compileGraph).mockResolvedValue({
        invoke: vi.fn().mockResolvedValueOnce({ __interrupt__: [{ value: payload }] }),
      } as any);

      const worker = await createWorker();
      const start = Date.now();
      const result = await worker.processJob(runJob);
      const elapsed = Date.now() - start;

      expect(result).toEqual({ status: "interrupted", interruptPayload: payload });
      expect(elapsed).toBeLessThan(500);
    });

    it("returns interrupted when invoke returns state with __interrupt__", async () => {
      const invoke = vi.fn().mockResolvedValueOnce({ __interrupt__: [{ value: { jobId: "j1" } }] });
      vi.mocked(compileGraph).mockResolvedValue({ invoke } as any);

      const worker = await createWorker();
      const result = await worker.processJob(runJob);

      expect(result.status).toBe("interrupted");
      expect(result.interruptPayload).toEqual({ jobId: "j1" });
      expect(invoke).toHaveBeenCalledTimes(1);
    });

    it("rethrows non-GraphInterrupt errors", async () => {
      vi.mocked(compileGraph).mockResolvedValue({
        invoke: vi.fn().mockRejectedValue(new Error("Graph failed")),
      } as any);

      const worker = await createWorker();
      await expect(worker.processJob(runJob)).rejects.toThrow("Graph failed");
    });
  });

  describe("resume job", () => {
    const resumeJob = {
      name: "resume" as const,
      data: {
        agentId: "default",
        threadId: "t1",
        result: "Approved",
        interruptPayload: { type: "human" as const },
      } satisfies AgentResumeData,
    } as Job<AgentResumeData, AgentJobResult>;

    it("returns completed with lastMessage when resume completes", async () => {
      // Resume flow: single invoke(Command(resume)) returns final state with messages
      const aiMessage = new AIMessage({ content: "Done." });
      vi.mocked(compileGraph).mockResolvedValue({
        invoke: vi.fn().mockResolvedValueOnce({ messages: [aiMessage] }),
      } as any);

      const worker = await createWorker();
      const result = await worker.processJob(resumeJob);

      expect(result).toEqual({ status: "completed", lastMessage: JSON.stringify("Done.") });
    });

    it("returns interrupted when resume invoke returns __interrupt__", async () => {
      const payload = { type: "tool", jobId: "j2" };
      vi.mocked(compileGraph).mockResolvedValue({
        invoke: vi.fn().mockResolvedValueOnce({ __interrupt__: [{ value: payload }] }),
      } as any);

      const worker = await createWorker();
      const start = Date.now();
      const result = await worker.processJob(resumeJob);
      const elapsed = Date.now() - start;

      expect(result).toEqual({ status: "interrupted", interruptPayload: payload });
      expect(elapsed).toBeLessThan(500);
    });
  });

  describe("interrupts do not hang", () => {
    it("processJob resolves when graph returns __interrupt__ (no hang)", async () => {
      vi.mocked(compileGraph).mockResolvedValue({
        invoke: vi.fn().mockResolvedValue({ __interrupt__: [{ value: { type: "human" } }] }),
      } as any);

      const worker = await createWorker();
      const hangTimeout = 2000;
      const result = await Promise.race([
        worker.processJob({
          name: "run",
          data: {
            agentId: "default",
            threadId: "t-hang-test",
            chatModelOptions: testModelOptions.chatModelOptions,
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
