import { describe, it, expect, vi, beforeEach } from "vitest";
import { BullMQAgentClient, ClientResultError } from "./client.js";
import { isResumeRequired } from "./utils/message.js";
import type { ModelOptions } from "./options.js";
import type { StoredAgentState, StoredHumanMessage } from "./queues/types.js";

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

const testModelOptions: { chatModelOptions: ModelOptions; embeddingModelOptions: ModelOptions } = {
  chatModelOptions: { provider: "openai", model: "gpt-4o-mini", apiKey: "test-key" },
  embeddingModelOptions: { provider: "openai", model: "text-embedding-3-small", apiKey: "test-key" },
};

describe("BullMQAgentClient", () => {
  let client: BullMQAgentClient;

  beforeEach(() => {
    client = new BullMQAgentClient(defaultClientOptions);
    mockAdd.mockReset();
    mockGetJob.mockReset();
    mockGetJob.mockResolvedValue({ waitUntilFinished: vi.fn().mockResolvedValue({ messages: [] }) });
    mockIngestAdd.mockReset();
    mockIngestAdd.mockResolvedValue({ id: "ingest-1" });
    mockIngestGetJob.mockReset();
    mockIngestGetJob.mockResolvedValue({ waitUntilFinished: vi.fn().mockResolvedValue({}) });
    mockSearchAdd.mockReset();
    mockSearchAdd.mockResolvedValue({ id: "search-1" });
    mockSearchGetJob.mockReset();
    mockSearchGetJob.mockResolvedValue({ waitUntilFinished: vi.fn().mockResolvedValue({ results: [], count: 0 }) });
  });

  describe("run", () => {
    it("returns jobId (fire-and-forget)", async () => {
      mockAdd.mockResolvedValue({ id: "job-1" });

      const message: StoredHumanMessage = { type: "human", data: { content: "Hi", name: undefined } };
      const threadId = "thread-1";
      const result = await client.run("default", threadId, { messages: [message] });

      expect(result.jobId).toBe("job-1");
      expect(mockAdd).toHaveBeenCalledWith(
        "run",
        expect.objectContaining({
          agentId: "default",
          threadId,
          input: { messages: [message] },
        }),
        expect.objectContaining({ jobId: expect.stringMatching(new RegExp(`^${threadId}/\\d+$`)) })
      );
    });

    it("uses provided agentId when given (request payload)", async () => {
      mockAdd.mockResolvedValue({ id: "job-2" });
      const result = await client.run(
        "my-agent",
        "thread-1",
        { messages: [{ type: "human", data: { content: "Hi", name: undefined } }] }
      );
      expect(result.jobId).toBe("job-2");
      expect(mockAdd).toHaveBeenCalledWith(
        "run",
        expect.objectContaining({ agentId: "my-agent" }),
        expect.objectContaining({ jobId: expect.stringMatching(/^thread-1\/\d+$/) })
      );
    });
  });

  describe("run (awaitable ClientResult)", () => {
    it("await result returns final state chunk when job completes", async () => {
      const jobId = "run-wait-1";
      const threadId = "thread-1";
      mockAdd.mockResolvedValue({ id: jobId });
      const mockWaitUntilFinished = vi.fn().mockResolvedValue({
        messages: [{ type: "human", data: { content: "Hi", role: "user" } }, { type: "ai", data: { content: "Hi back", tool_calls: [] } }],
      });
      mockGetJob.mockResolvedValue({
        id: jobId,
        waitUntilFinished: mockWaitUntilFinished,
      });

      const runResult = await client.run(
        "default",
        threadId,
        { messages: [{ type: "human", data: { content: "Hi", name: undefined } }], ttl: 5_000 }
      );
      const result = await runResult.promise;

      expect(result).toBeDefined();
      expect(result.messages).toBeDefined();
    });

    it("await runResult resolves to AgentJobResult (default TTL)", async () => {
      const jobId = "run-await-1";
      mockAdd.mockResolvedValue({ id: jobId });
      mockGetJob.mockResolvedValue({
        id: jobId,
        waitUntilFinished: vi.fn().mockResolvedValue({ messages: [{ type: "ai", data: { content: "Done", tool_calls: [] } }] }),
      });

      const runResult = await client.run("default", "t1", { messages: [{ type: "human", data: { content: "Hi", name: undefined } }] });
      const result = await runResult.promise;

      expect(result).toBeDefined();
      expect(result.messages).toBeDefined();
    });

    it("await result returns serialized state (messages) when job finishes interrupted (does not hang)", async () => {
      const jobId = "run-wait-2";
      mockAdd.mockResolvedValue({ id: jobId });
      mockGetJob.mockResolvedValue({
        id: jobId,
        waitUntilFinished: vi.fn().mockResolvedValue({ messages: [] }),
      });

      const runResult = await client.run(
        "default",
        "t2",
        { messages: [{ type: "human", data: { content: "Do it", name: undefined } }], ttl: 5_000 }
      );
      const result = await runResult.promise;

      expect(result).toBeDefined();
      expect(result.messages).toBeDefined();
      expect(Array.isArray(result.messages)).toBe(true);
    });

    it("rejects with ClientResultError when job not found", async () => {
      mockAdd.mockResolvedValue({ id: "job-1" });
      mockGetJob.mockResolvedValue(null);

      const runResult = await client.run("default", "thread-1", {
        messages: [{ type: "human", data: { content: "Hi", name: undefined } }],
        ttl: 5_000,
      });

      await expect(runResult.promise).rejects.toThrow(ClientResultError);
      await expect(runResult.promise).rejects.toMatchObject({
        status: "job_not_found",
        message: expect.stringContaining("Job job-1 not found"),
      });
    });

    it("await result resolves within ttl when job returns interrupted (no hang)", async () => {
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
        { chatModelOptions: testModelOptions.chatModelOptions, messages: [{ type: "human", data: { content: "x", name: undefined } }], ttl: 10_000 }
      );
      const start = Date.now();
      const result = await Promise.race([
        runResult.promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("await hung")), 2000)
        ),
      ]);
      const elapsed = Date.now() - start;

      expect(result.status).toBe("interrupted");
      expect(elapsed).toBeLessThan(2000);
    });
  });

  describe("run with full messages (resume-style)", () => {
    it("adds run job with messages", async () => {
      mockAdd.mockResolvedValue({ id: "resume-1" });

      const messages: StoredHumanMessage[] = [
        { type: "human", data: { content: "Hi", name: undefined } },
        { type: "human", data: { content: "Approved", name: undefined } },
      ];
      const result = await client.run("default", "t1", { messages });

      expect(result.jobId).toBe("resume-1");
      expect(typeof result.promise).toBe("object");
      expect(mockAdd).toHaveBeenCalledWith(
        "run",
        expect.objectContaining({
          agentId: "default",
          threadId: "t1",
          input: { messages },
        }),
        expect.objectContaining({ jobId: expect.stringMatching(/^t1\/\d+$/) })
      );
    });

    it("await result returns chunk when resume job finishes", async () => {
      mockAdd.mockResolvedValue({ id: "resume-wait-1" });
      mockGetJob.mockResolvedValue({
        id: "resume-wait-1",
        waitUntilFinished: vi.fn().mockResolvedValue({ messages: [{ type: "ai", data: { content: "Done.", tool_calls: [] } }] }),
      });

      const resumeData = {
        messages: [{ type: "human", data: { content: "Approved", name: undefined } } satisfies StoredHumanMessage],
      };
      const runResult = await client.run("default", "t1", { ...resumeData, ttl: 5_000 });
      const result = await runResult.promise;

      expect(result.messages).toBeDefined();
    });

    it("await result returns serialized state when run finishes interrupted (does not hang)", async () => {
      mockAdd.mockResolvedValue({ id: "resume-wait-2" });
      mockGetJob.mockResolvedValue({
        id: "resume-wait-2",
        waitUntilFinished: vi.fn().mockResolvedValue({ messages: [] }),
      });

      const resumeData = { messages: [{ type: "human", data: { content: "Approved", name: undefined } } satisfies StoredHumanMessage] };
      const runResult = await client.run("default", "t1", { ...resumeData, ttl: 5_000 });
      const result = await runResult.promise;

      expect(result).toBeDefined();
      expect(result.messages).toBeDefined();
    });
  });

  describe("run then resumeTool cycle", () => {
    it("when first run returns resume-required result, resumeTool completes the flow", async () => {
      const threadId = "t-cycle";
      const jobIdRun = "t-cycle/1001";
      const jobIdResume = "t-cycle/1002";
      const resumeRequiredResult: StoredAgentState = {
        messages: [
          { type: "human", data: { content: "Approve this", name: undefined } },
          {
            type: "ai",
            data: {
              content: "",
              tool_calls: [{ id: "call_1", name: "request_human_approval", args: { reason: "Proceed?" } }],
            },
          },
        ],
      };
      const finalResult: StoredAgentState = {
        messages: [
          ...resumeRequiredResult.messages,
          { type: "tool", data: { content: "Approved", tool_call_id: "call_1", name: "request_human_approval" } },
          { type: "ai", data: { content: "Done.", tool_calls: [] } },
        ],
      };
      mockAdd
        .mockResolvedValueOnce({ id: jobIdRun })
        .mockResolvedValueOnce({ id: jobIdResume });
      mockGetJob
        .mockResolvedValueOnce({
          id: jobIdRun,
          waitUntilFinished: vi.fn().mockResolvedValue(resumeRequiredResult),
        })
        .mockResolvedValueOnce({
          id: jobIdResume,
          waitUntilFinished: vi.fn().mockResolvedValue(finalResult),
        });

      const runResult = await client.run("agent-1", threadId, {
        messages: [{ type: "human", data: { content: "Approve this", name: undefined } }],
        ttl: 5_000,
      });
      const first = await runResult.promise;
      expect(isResumeRequired(first)).toBe(true);

      const resumeToolResult = await client.resumeTool("agent-1", threadId, { content: "Approved", ttl: 5_000 });
      expect(mockAdd).toHaveBeenLastCalledWith(
        "resumeTool",
        expect.objectContaining({ agentId: "agent-1", threadId, content: "Approved" }),
        expect.objectContaining({ jobId: expect.stringMatching(new RegExp(`^${threadId}/\\d+$`)) })
      );
      const second = await resumeToolResult.promise;
      expect(second).toBeDefined();
      expect(second.messages?.length).toBeGreaterThan(resumeRequiredResult.messages.length);
    });
  });

  describe("resumeTool", () => {
    it("adds resumeTool job with content", async () => {
      mockAdd.mockResolvedValue({ id: "resume-tool-1" });

      const result = await client.resumeTool("default", "t1", { content: "Approved" });

      expect(result.jobId).toBe("resume-tool-1");
      expect(mockAdd).toHaveBeenCalledWith(
        "resumeTool",
        expect.objectContaining({
          agentId: "default",
          threadId: "t1",
          content: "Approved",
        }),
        expect.objectContaining({ jobId: expect.stringMatching(/^t1\/\d+$/) })
      );
    });

    it("await result returns chunk when resumeTool job finishes", async () => {
      mockAdd.mockResolvedValue({ id: "resume-tool-wait-1" });
      mockGetJob.mockResolvedValue({
        id: "resume-tool-wait-1",
        waitUntilFinished: vi.fn().mockResolvedValue({ messages: [{ type: "ai", data: { content: "Done.", tool_calls: [] } }] }),
      });

      const resumeResult = await client.resumeTool("default", "t1", { content: "Yes", ttl: 5_000 });
      const result = await resumeResult.promise;

      expect(result).toBeDefined();
      expect(result.messages).toBeDefined();
    });
  });

  describe("buildRunFlowChild, buildResumeToolFlowChild", () => {
    it("buildRunFlowChild returns flow child spec for run (no job added)", () => {
      const message: StoredHumanMessage = { type: "human", data: { content: "Hi", name: undefined } };
      const child = client.buildRunFlowChild("agent-1", "thread-1", { messages: [message] });

      expect(child.name).toBe("run");
      expect(child.queueName).toBe("agent");
      expect(child.data).toEqual({
        agentId: "agent-1",
        threadId: "thread-1",
        input: { messages: [message] },
      });
      expect(child.opts?.jobId).toMatch(/^thread-1\/\d+$/);
      expect(mockAdd).not.toHaveBeenCalled();
    });

    it("buildResumeToolFlowChild returns flow child spec for resumeTool", () => {
      const child = client.buildResumeToolFlowChild("agent-1", "thread-3", { content: "Approved" });

      expect(child.name).toBe("resumeTool");
      expect(child.queueName).toBe("agent");
      expect(child.data).toEqual({
        agentId: "agent-1",
        threadId: "thread-3",
        content: "Approved",
      });
      expect(child.opts?.jobId).toMatch(/^thread-3\/\d+$/);
      expect(mockAdd).not.toHaveBeenCalled();
    });
  });

  describe("ingest", () => {
    it("returns jobId and is awaitable (fire-and-forget or await result)", async () => {
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
      expect(typeof result.promise).toBe("object");
    });

    it("await result returns ingest result when job completes", async () => {
      mockIngestAdd.mockResolvedValue({ id: "ingest-2" });
      mockIngestGetJob.mockResolvedValue({
        id: "ingest-2",
        waitUntilFinished: vi.fn().mockResolvedValue({ documents: 3, chunks: 10 }),
      });

      const ingestResult = await client.ingest({
        agentId: "default",
        source: { type: "text", content: "Doc 1" },
        ttl: 5_000,
      });
      const result = await ingestResult.promise;

      expect(result).toEqual({ documents: 3, chunks: 10 });
    });
  });

  describe("searchKnowledge", () => {
    it("returns jobId and is awaitable (fire-and-forget or await result)", async () => {
      mockSearchAdd.mockResolvedValue({ id: "search-1" });

      const result = await client.searchKnowledge("default", "some query", { k: 3 });

      expect(mockSearchAdd).toHaveBeenCalledWith("search", {
        agentId: "default",
        query: "some query",
        k: 3,
      });
      expect(result.jobId).toBe("search-1");
      expect(typeof result.promise).toBe("object");
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

    it("await result returns search result when job completes", async () => {
      mockSearchAdd.mockResolvedValue({ id: "search-3" });
      mockSearchGetJob.mockResolvedValue({
        id: "search-3",
        waitUntilFinished: vi.fn().mockResolvedValue({
          results: [{ content: "doc 1", metadata: {} }],
          count: 1,
        }),
      });

      const searchResult = await client.searchKnowledge("default", "query", { k: 5, ttl: 5_000 });
      const result = await searchResult.promise;

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
