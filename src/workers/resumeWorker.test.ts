import { describe, it, expect, vi } from "vitest";
import { ResumeWorker } from "./resumeWorker.js";
import { compileGraph } from "../agent/compile.js";
import { AIMessage } from "@langchain/core/messages";

vi.mock("../agent/compile.js");

async function createResumeWorker(invokeResult: { messages?: unknown[]; __interrupt__?: { value: unknown }[] }) {
  const invoke = vi.fn().mockResolvedValue(invokeResult);
  const runnable = { invoke };
  const compiledGraph = {
    getRunnable: vi.fn().mockResolvedValue(runnable),
  };
  vi.mocked(compileGraph).mockResolvedValue(compiledGraph as Awaited<ReturnType<typeof compileGraph>>);
  const worker = new ResumeWorker({ compiledGraph: await compileGraph({} as never) });
  worker.start();
  return { worker, compiledGraph, runnable };
}

const baseConfigurable = {
  thread_id: "t1",
  agentId: "agent-1",
  job: {},
  chatModelOptions: { provider: "openai", model: "gpt-4o-mini", apiKey: "key" },
  embeddingModelOptions: { provider: "openai", model: "text-embedding-3-small", apiKey: "key" },
};

const subagentId = undefined;
const chatModelOptions = baseConfigurable.chatModelOptions;

describe("ResumeWorker.runResume", () => {
  it("returns completed with lastMessage when graph returns final messages", async () => {
    const aiMessage = new AIMessage({ content: "Done." });
    const { worker } = await createResumeWorker({ messages: [aiMessage], __interrupt__: [] });

    const result = await worker.runResume(baseConfigurable as never, { messages: [] }, subagentId, chatModelOptions);

    expect(result).toEqual({ status: "completed", lastMessage: JSON.stringify("Done.") });
  });

  it("returns interrupted with payload when graph returns __interrupt__", async () => {
    const payload = { type: "human", message: "Approve?" };
    const { worker } = await createResumeWorker({ messages: [], __interrupt__: [{ value: payload }] });

    const result = await worker.runResume(
      baseConfigurable as never,
      { content: "Approved" },
      subagentId,
      chatModelOptions
    );

    expect(result).toEqual({ status: "interrupted", interruptPayload: payload });
  });

  it("invokes runnable with Command(resume: { content })", async () => {
    const { worker, compiledGraph, runnable } = await createResumeWorker({ messages: [], __interrupt__: [] });
    const resumePayload = { content: "ok" };

    await worker.runResume(baseConfigurable as never, resumePayload, subagentId, chatModelOptions);

    expect(compiledGraph.getRunnable).toHaveBeenCalledWith(subagentId, chatModelOptions);
    expect(runnable.invoke).toHaveBeenCalledTimes(1);
    const [command, options] = (runnable.invoke as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(command).toBeDefined();
    expect(command?.resume).toEqual({ content: "ok" });
    expect(options?.configurable).toEqual(baseConfigurable);
  });

  it("passes human resume result { content } as { content } to graph", async () => {
    const { worker, runnable } = await createResumeWorker({ messages: [], __interrupt__: [] });

    await worker.runResume(
      baseConfigurable as never,
      { content: "yes" },
      subagentId,
      chatModelOptions
    );

    const [command] = (runnable.invoke as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(command?.resume).toEqual({
      content: "yes"
    });
  });
});
