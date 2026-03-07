import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Job } from "bullmq";
import { AggregatorWorker } from "./aggregatorWorker.js";
import { ResumeWorker } from "./resumeWorker.js";
import { compileGraph } from "../agent/compile.js";
import { createDefaultAgentWorkerLogger } from "../options.js";
import type { AggregatorJobData } from "../queues/types.js";

vi.mock("../agent/compile.js");

const mockConnection = { url: "redis://localhost" };

const testModelOptions = {
  chatModelOptions: { provider: "openai", model: "gpt-4o-mini", apiKey: "test-key" },
  embeddingModelOptions: { provider: "openai", model: "text-embedding-3-small", apiKey: "test-key" },
};

async function createAggregatorWorker(resumeWorker: ResumeWorker) {
  return new AggregatorWorker(
    { resumeWorker, embeddingModelOptions: testModelOptions.embeddingModelOptions, logger: createDefaultAgentWorkerLogger() },
    { connection: mockConnection }
  );
}

function createMockJob(childrenValues: Record<string, unknown>): Job<AggregatorJobData> {
  return {
    data: { agentId: "agent-1", threadId: "thread-1", chatModelOptions: testModelOptions.chatModelOptions, goalId: "default" },
    getChildrenValues: vi.fn().mockResolvedValue(childrenValues),
  } as unknown as Job<AggregatorJobData>;
}

describe("AggregatorWorker.processJob", () => {
  beforeEach(() => {
    vi.mocked(compileGraph).mockReset();
  });

  it("sorts children by job id and resumes graph with ordered messages", async () => {
    const toolMsg1 = { type: "tool" as const, data: { content: "result1", role: undefined, name: undefined, tool_call_id: "tc-1" } };
    const toolMsg2 = { type: "tool" as const, data: { content: "result2", role: undefined, name: undefined, tool_call_id: "tc-2" } };
    // Snowflake-like IDs: later id sorts after earlier when sorted lexicographically (numeric string sort)
    const childrenValues = { "1002": toolMsg2, "1001": toolMsg1 };
    const compiledGraph = {
      invoke: vi.fn().mockResolvedValue({ messages: [], __interrupt__: [] }),
    };
    vi.mocked(compileGraph).mockResolvedValue(compiledGraph);

    const resumeWorker = new ResumeWorker({ compiledGraph: await compileGraph({} as never) });
    resumeWorker.start();
    const worker = await createAggregatorWorker(resumeWorker);
    const job = createMockJob(childrenValues);

    const result = await worker.processJob(job);

    expect(result.status).toBe("completed");
    expect(compiledGraph.invoke).toHaveBeenCalledTimes(1);
    const [, invokeOptions] = (compiledGraph.invoke as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const resumeArg = invokeOptions?.configurable;
    expect(resumeArg).toBeDefined();
    const commandPayload = (compiledGraph.invoke as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(commandPayload?.resume).toEqual({ messages: [toolMsg1, toolMsg2] });
  });

  it("calls runResume with configurable containing threadId, agentId, and model options", async () => {
    const childrenValues = { "1": { type: "tool", data: { content: "ok", role: undefined, name: undefined, tool_call_id: "tc-1" } } };
    const compiledGraph = {
      invoke: vi.fn().mockResolvedValue({ messages: [], __interrupt__: [] }),
    };
    vi.mocked(compileGraph).mockResolvedValue(compiledGraph);

    const resumeWorker = new ResumeWorker({ compiledGraph: await compileGraph({} as never) });
    resumeWorker.start();
    const worker = await createAggregatorWorker(resumeWorker);
    const job = createMockJob(childrenValues);

    await worker.processJob(job);

    expect(compiledGraph.invoke).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        configurable: expect.objectContaining({
          thread_id: "thread-1",
          agentId: "agent-1",
          goalId: "default",
          chatModelOptions: testModelOptions.chatModelOptions,
          embeddingModelOptions: testModelOptions.embeddingModelOptions,
        }),
      })
    );
  });
});
