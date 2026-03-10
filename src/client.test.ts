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

const mockIngestAdd = vi.fn();
const mockIngestGetJob = vi.fn();
vi.mock("./queues/ingestQueue.js", () => ({
  createIngestQueue: () => ({
    add: mockIngestAdd,
    getJob: mockIngestGetJob,
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

const mockSearchAdd = vi.fn();
const mockSearchGetJob = vi.fn();
vi.mock("./queues/searchQueue.js", () => ({
  createSearchQueue: () => ({
    add: mockSearchAdd,
    getJob: mockSearchGetJob,
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("./options.js", () => ({
  QUEUE_NAMES: {
    AGENT: "agent",
    TOOLS: "tools",
    INGEST: "ingest",
    SEARCH: "search",
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
    mockIngestAdd.mockReset();
    mockIngestAdd.mockResolvedValue({ id: "ingest-1" });
    mockIngestGetJob.mockReset();
    mockSearchAdd.mockReset();
    mockSearchAdd.mockResolvedValue({ id: "search-1" });
    mockSearchGetJob.mockReset();
  });

  describe("run", () => {
    it("returns jobId (fire-and-forget)", async () => {
      mockAdd.mockResolvedValue({ id: "job-1" });

      const message = { type: "human", data: { content: "Hi", role: "user", name: undefined, tool_call_id: undefined } };
      const threadId = "thread-1";
      const result = await client.run("default", threadId, { messages: [message] });

      expect(result.jobId).toBe("job-1");
      expect(mockAdd).toHaveBeenCalledWith(
        "run",
        expect.objectContaining({
          agentId: "default",
          threadId,
          input: { messages: [message] },
        })
      );
    });

    it("uses provided agentId when given (request payload)", async () => {
      mockAdd.mockResolvedValue({ id: "job-2" });
      const result = await client.run(
        "my-agent",
        "thread-1",
        { messages: [{ type: "human", data: { content: "Hi", role: "user", name: undefined, tool_call_id: undefined } }] }
      );
      expect(result.jobId).toBe("job-2");
      expect(mockAdd).toHaveBeenCalledWith(
        "run",
        expect.objectContaining({ agentId: "my-agent" })
      );
    });
  });

  describe("run (awaitable ClientResult)", () => {
    it("result.wait() returns completed when job finishes with status completed", async () => {
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

      const runResult = await client.run(
        "default",
        threadId,
        { messages: [{ type: "human", data: { content: "Hi", role: "user", name: undefined, tool_call_id: undefined } }] }
      );
      const result = await runResult.wait(5_000);

      expect(result.status).toBe("completed");
      expect(result.lastMessage).toBe("Hi back");
    });

    it("runResult.wait() resolves to AgentJobResult (default TTL)", async () => {
      const jobId = "run-await-1";
      mockAdd.mockResolvedValue({ id: jobId });
      mockGetJob.mockResolvedValue({
        id: jobId,
        waitUntilFinished: vi.fn().mockResolvedValue({ status: "completed", lastMessage: "Done" }),
      });

      const runResult = await client.run("default", "t1", { messages: [{ type: "human", data: { content: "Hi", role: "user", name: undefined, tool_call_id: undefined } }] });
      const result = await runResult.wait();

      expect(result.status).toBe("completed");
      expect(result.lastMessage).toBe("Done");
    });

    it("result.wait() returns interrupted with payload when job finishes with status interrupted (does not hang)", async () => {
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

      const runResult = await client.run(
        "default",
        "t2",
        { chatModelOptions: testModelOptions.chatModelOptions, messages: [{ type: "human", data: { content: "Do it", role: "user", name: undefined, tool_call_id: undefined } }] }
      );
      const result = await runResult.wait(5_000);

      expect(result.status).toBe("interrupted");
      expect(result.interruptPayload).toEqual(interruptPayload);
    });

    it("result.wait() resolves within ttl when job returns interrupted (no hang)", async () => {
      mockAdd.mockResolvedValue({ id: "j1" });
      mockGetJob.mockResolvedValue({
        id: "j1",
        waitUntilFinished: vi.fn().mockResolvedValue({
          status: "interrupted",
          interruptPayload: {},
        }),
      });

      const runResult = await client.run(
        "default",
        "thread-1",
        { chatModelOptions: testModelOptions.chatModelOptions, messages: [{ type: "human", data: { content: "x", role: "user", name: undefined, tool_call_id: undefined } }] }
      );
      const start = Date.now();
      const result = await Promise.race([
        runResult.wait(10_000),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("wait() hung")), 2000)
        ),
      ]);
      const elapsed = Date.now() - start;

      expect(result.status).toBe("interrupted");
      expect(elapsed).toBeLessThan(2000);
    });
  });

  describe("resume", () => {
    it("returns jobId and wait() (fire-and-forget or await result.wait())", async () => {
      mockAdd.mockResolvedValue({ id: "resume-1" });

      const resumeData = { content: "Approved" };
      const result = await client.resume("default", "t1", resumeData);

      expect(result.jobId).toBe("resume-1");
      expect(typeof result.wait).toBe("function");
      expect(mockAdd).toHaveBeenCalledWith(
        "resume",
        expect.objectContaining({ agentId: "default", threadId: "t1", result: resumeData })
      );
    });

    it("result.wait() returns completed when resume job finishes", async () => {
      mockAdd.mockResolvedValue({ id: "resume-wait-1" });
      mockGetJob.mockResolvedValue({
        id: "resume-wait-1",
        waitUntilFinished: vi.fn().mockResolvedValue({
          status: "completed",
          lastMessage: "Done.",
        }),
      });

      const resumeData = { content: "Approved" };
      const resumeResult = await client.resume("default", "t1", resumeData);
      const result = await resumeResult.wait(5_000);

      expect(result.status).toBe("completed");
      expect(result.lastMessage).toBe("Done.");
    });

    it("result.wait() returns interrupted when resume job finishes with human interrupt (does not hang)", async () => {
      mockAdd.mockResolvedValue({ id: "resume-wait-2" });
      mockGetJob.mockResolvedValue({
        id: "resume-wait-2",
        waitUntilFinished: vi.fn().mockResolvedValue({
          status: "interrupted",
          interruptPayload: { type: "human", message: "Approve?" },
        }),
      });

      const resumeData = { content: "Approved" };
      const resumeResult = await client.resume("default", "t1", resumeData);
      const result = await resumeResult.wait(5_000);

      expect(result.status).toBe("interrupted");
      expect(result.interruptPayload).toEqual({ type: "human", message: "Approve?" });
    });
  });

  describe("ingest", () => {
    it("returns jobId and wait() (fire-and-forget or await result.wait())", async () => {
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
      expect(typeof result.wait).toBe("function");
    });

    it("result.wait() returns ingest result when job completes", async () => {
      mockIngestAdd.mockResolvedValue({ id: "ingest-2" });
      mockIngestGetJob.mockResolvedValue({
        id: "ingest-2",
        waitUntilFinished: vi.fn().mockResolvedValue({ ingested: 3 }),
      });

      const ingestResult = await client.ingest({
        agentId: "default",
        source: { type: "text", content: "Doc 1" },
      });
      const result = await ingestResult.wait(5_000);

      expect(result).toEqual({ ingested: 3 });
    });
  });

  describe("searchKnowledge", () => {
    it("returns jobId and wait() (fire-and-forget or await result.wait())", async () => {
      mockSearchAdd.mockResolvedValue({ id: "search-1" });

      const result = await client.searchKnowledge("default", "some query", { k: 3 });

      expect(mockSearchAdd).toHaveBeenCalledWith("search", {
        agentId: "default",
        query: "some query",
        k: 3,
      });
      expect(result.jobId).toBe("search-1");
      expect(typeof result.wait).toBe("function");
    });

    it("uses default k=5 when options omitted", async () => {
      mockSearchAdd.mockResolvedValue({ id: "search-2" });

      await client.searchKnowledge("my-agent", "query");

      expect(mockSearchAdd).toHaveBeenCalledWith("search", {
        agentId: "my-agent",
        query: "query",
        k: 5,
      });
    });

    it("result.wait() returns search result when job completes", async () => {
      mockSearchAdd.mockResolvedValue({ id: "search-3" });
      mockSearchGetJob.mockResolvedValue({
        id: "search-3",
        waitUntilFinished: vi.fn().mockResolvedValue({
          results: [{ content: "doc 1", metadata: {} }],
          count: 1,
        }),
      });

      const searchResult = await client.searchKnowledge("default", "query", { k: 5 });
      const result = await searchResult.wait(5_000);

      expect(result).toEqual({
        results: [{ content: "doc 1", metadata: {} }],
        count: 1,
      });
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
