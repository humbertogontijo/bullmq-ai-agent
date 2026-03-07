import { describe, it, expect, vi } from "vitest";
import { ResumeWorker } from "./resumeWorker.js";
import { compileGraph } from "../agent/compile.js";
import { AIMessage } from "@langchain/core/messages";

vi.mock("../agent/compile.js");

async function createResumeWorker(invokeResult: { messages?: unknown[]; __interrupt__?: { value: unknown }[] }) {
  const compiledGraph = {
    invoke: vi.fn().mockResolvedValue(invokeResult),
  };
  vi.mocked(compileGraph).mockResolvedValue(compiledGraph);
  const worker = new ResumeWorker({ compiledGraph: await compileGraph({} as never) });
  worker.start();
  return { worker, compiledGraph };
}

const baseConfigurable = {
  thread_id: "t1",
  agentId: "agent-1",
  job: {},
  chatModelOptions: { provider: "openai", model: "gpt-4o-mini", apiKey: "key" },
  embeddingModelOptions: { provider: "openai", model: "text-embedding-3-small", apiKey: "key" },
};

describe("ResumeWorker.runResume", () => {
  it("returns completed with lastMessage when graph returns final messages", async () => {
    const aiMessage = new AIMessage({ content: "Done." });
    const { worker } = await createResumeWorker({ messages: [aiMessage], __interrupt__: [] });

    const result = await worker.runResume(baseConfigurable as never, { messages: [] });

    expect(result).toEqual({ status: "completed", lastMessage: JSON.stringify("Done.") });
  });

  it("returns interrupted with payload when graph returns __interrupt__", async () => {
    const payload = { type: "human", message: "Approve?" };
    const { worker } = await createResumeWorker({ messages: [], __interrupt__: [{ value: payload }] });

    const result = await worker.runResume(baseConfigurable as never, "Approved");

    expect(result).toEqual({ status: "interrupted", interruptPayload: payload });
  });

  it("invokes graph with Command(resume: result)", async () => {
    const { worker, compiledGraph } = await createResumeWorker({ messages: [], __interrupt__: [] });
    const resumePayload = { messages: [{ type: "tool", data: { content: "ok", tool_call_id: "tc-1" } }] };

    await worker.runResume(baseConfigurable as never, resumePayload);

    expect(compiledGraph.invoke).toHaveBeenCalledTimes(1);
    const [command, options] = (compiledGraph.invoke as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(command).toBeDefined();
    expect(command?.resume).toEqual(resumePayload);
    expect(options?.configurable).toEqual(baseConfigurable);
  });
});
