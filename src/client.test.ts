import { describe, it, expect, vi, beforeEach } from "vitest";
import { BullMQAgentClient } from "./client.js";

const mockAdd = vi.fn();
const mockGetJob = vi.fn();

vi.mock("bullmq", () => ({
  QueueEvents: vi.fn().mockImplementation(function (this: unknown) {
    return {
      close: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

vi.mock("./queues/agentQueue.js", () => ({
  createAgentQueue: () => ({
    add: mockAdd,
    getJob: mockGetJob,
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

const mockAggregatorGetJob = vi.fn();
vi.mock("./queues/aggregatorQueue.js", () => ({
  createAggregatorQueue: () => ({
    getJob: mockAggregatorGetJob,
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

const mockIngestAdd = vi.fn();
vi.mock("./queues/ingestQueue.js", () => ({
  createIngestQueue: () => ({
    add: mockIngestAdd,
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("./options.js", () => ({
  QUEUE_NAMES: {
    AGENT: "agent",
    TOOLS: "tools",
    INGEST: "ingest",
    AGGREGATOR: "aggregator",
  },
}));

const defaultClientOptions = { connection: { url: "redis://localhost" } };

const testModelOptions = {
  chatModelOptions: { provider: "openai", model: "gpt-4o-mini", apiKey: "test-key" } as const,
  embeddingModelOptions: { provider: "openai", model: "text-embedding-3-small", apiKey: "test-key" } as const,
};

describe("BullMQAgentClient", () => {
  let client: BullMQAgentClient;

  beforeEach(() => {
    client = new BullMQAgentClient(defaultClientOptions);
    mockAdd.mockReset();
    mockGetJob.mockReset();
    mockIngestAdd.mockResolvedValue({ id: "ingest-1" });
  });

  describe("run", () => {
    it("returns agentId, threadId and jobId (fire-and-forget)", async () => {
      mockAdd.mockResolvedValue({ id: "job-1" });

      const message = { type: "human", data: { content: "Hi", role: "user", name: undefined, tool_call_id: undefined } };
      const threadId = "thread-1";
      const result = await client.run("default", threadId, { chatModelOptions: testModelOptions.chatModelOptions, messages: [message] });

      expect(result.agentId).toBe("default");
      expect(result.threadId).toBe(threadId);
      expect(result.jobId).toBe("job-1");
      expect(mockAdd).toHaveBeenCalledWith(
        "run",
        expect.objectContaining({
          agentId: "default",
          threadId,
          chatModelOptions: testModelOptions.chatModelOptions,
          input: { messages: [message] },
        })
      );
    });

    it("uses provided agentId when given", async () => {
      mockAdd.mockResolvedValue({ id: "job-2" });
      const result = await client.run(
        "my-agent",
        "thread-1",
        { chatModelOptions: testModelOptions.chatModelOptions, messages: [{ type: "human", data: { content: "Hi", role: "user", name: undefined, tool_call_id: undefined } }] }
      );
      expect(result.agentId).toBe("my-agent");
      expect(mockAdd).toHaveBeenCalledWith(
        "run",
        expect.objectContaining({ agentId: "my-agent" })
      );
    });
  });

  describe("runAndWait", () => {
    it("returns completed with threadId when job finishes with status completed", async () => {
      const jobId = "run-wait-1";
      const threadId = "thread-1";
      mockAdd.mockResolvedValue({ id: jobId });
      const mockWaitUntilFinished = vi.fn().mockResolvedValue({
        status: "completed",
        lastMessage: "Hi back",
      });
      mockGetJob.mockResolvedValue({
        id: jobId,
        waitUntilFinished: mockWaitUntilFinished,
      });

      const result = await client.runAndWait(
        "default",
        threadId,
        { chatModelOptions: testModelOptions.chatModelOptions, messages: [{ type: "human", data: { content: "Hi", role: "user", name: undefined, tool_call_id: undefined } }] },
        5_000
      );

      expect(result.status).toBe("completed");
      expect(result.lastMessage).toBe("Hi back");
    });

    it("returns interrupted with payload when job finishes with status interrupted (does not hang)", async () => {
      const jobId = "run-wait-2";
      mockAdd.mockResolvedValue({ id: jobId });
      const interruptPayload = { type: "human", message: "Approve?" };
      mockGetJob.mockResolvedValue({
        id: jobId,
        waitUntilFinished: vi.fn().mockResolvedValue({
          status: "interrupted",
          interruptPayload,
        }),
      });

      const result = await client.runAndWait(
        "default",
        "t2",
        { chatModelOptions: testModelOptions.chatModelOptions, messages: [{ type: "human", data: { content: "Do it", role: "user", name: undefined, tool_call_id: undefined } }] },
        5_000
      );

      expect(result.status).toBe("interrupted");
      expect(result.interruptPayload).toEqual(interruptPayload);
    });

    it("resolves within ttl when job returns interrupted (no hang)", async () => {
      mockAdd.mockResolvedValue({ id: "j1" });
      mockGetJob.mockResolvedValue({
        id: "j1",
        waitUntilFinished: vi.fn().mockResolvedValue({
          status: "interrupted",
          interruptPayload: {},
        }),
      });

      const start = Date.now();
      const result = await Promise.race([
        client.runAndWait("default", "thread-1", { chatModelOptions: testModelOptions.chatModelOptions, messages: [{ type: "human", data: { content: "x", role: "user", name: undefined, tool_call_id: undefined } }] }, 10_000),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("runAndWait hung")), 2000)
        ),
      ]);
      const elapsed = Date.now() - start;

      expect(result.status).toBe("interrupted");
      expect(elapsed).toBeLessThan(2000);
    });
  });

  describe("resume", () => {
    it("returns jobId (fire-and-forget)", async () => {
      mockAdd.mockResolvedValue({ id: "resume-1" });

      const result = await client.resume("default", "t1", "Approved");

      expect(result.jobId).toBe("resume-1");
      expect(mockAdd).toHaveBeenCalledWith(
        "resume",
        expect.objectContaining({ agentId: "default", threadId: "t1", result: "Approved" })
      );
    });
  });

  describe("resumeAndWait", () => {
    it("returns completed when resume job finishes", async () => {
      mockAdd.mockResolvedValue({ id: "resume-wait-1" });
      mockGetJob.mockResolvedValue({
        id: "resume-wait-1",
        waitUntilFinished: vi.fn().mockResolvedValue({
          status: "completed",
          lastMessage: "Done.",
        }),
      });

      const result = await client.resumeAndWait("default", "t1", "Approved", 5_000);

      expect(result.status).toBe("completed");
      expect(result.lastMessage).toBe("Done.");
    });

    it("returns interrupted when resume job finishes with human interrupt (does not hang)", async () => {
      mockAdd.mockResolvedValue({ id: "resume-wait-2" });
      mockGetJob.mockResolvedValue({
        id: "resume-wait-2",
        waitUntilFinished: vi.fn().mockResolvedValue({
          status: "interrupted",
          interruptPayload: { type: "human", message: "Approve?" },
        }),
      });

      const result = await client.resumeAndWait("default", "t1", "Approved", 5_000);

      expect(result.status).toBe("interrupted");
      expect(result.interruptPayload).toEqual({ type: "human", message: "Approve?" });
    });
  });

  describe("ingest", () => {
    it("adds ingest job with agentId and documents", async () => {
      mockIngestAdd.mockResolvedValue({ id: "ingest-1" });

      const result = await client.ingest({
        agentId: "default",
        source: { type: "text", content: "Doc 1" },
      });

      expect(mockIngestAdd).toHaveBeenCalledWith("ingest", {
        agentId: "default",
        source: { type: "text", content: "Doc 1" },
      });
      expect(result.jobId).toBe("ingest-1");
    });
  });

  describe("getAgentJob", () => {
    it("returns job when found", async () => {
      const job = { id: "j1", data: {} };
      mockGetJob.mockResolvedValue(job);

      const out = await client.getAgentJob("j1");

      expect(mockGetJob).toHaveBeenCalledWith("j1");
      expect(out).toBe(job);
    });

    it("returns null when getJob returns null", async () => {
      mockGetJob.mockResolvedValue(null);

      const out = await client.getAgentJob("missing");

      expect(out).toBeNull();
    });
  });
});
