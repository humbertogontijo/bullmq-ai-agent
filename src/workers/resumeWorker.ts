import type { BaseMessage, StoredMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import type { CompiledGraph } from "../agent/compile.js";
import type { ModelOptions, RunContext } from "../options.js";
import type { AgentJobResult, ResumeData } from "../queues/types.js";
import { getLastAIMessage } from "../utils/message.js";

export interface ResumeWorkerParams {
  compiledGraph: CompiledGraph;
}

/**
 * Holds the compiled runnables and shared resume logic. Created once in BullMQAgentWorker
 * and passed to AgentWorker so they share the same getRunnable instance.
 */
export class ResumeWorker {
  private readonly compiledGraph: CompiledGraph;
  private _started = false;

  constructor(params: ResumeWorkerParams) {
    this.compiledGraph = params.compiledGraph;
  }

  async start() {
    if (this._started) return;
  }

  /**
   * Runs the shared resume flow using the runnable for the given subagentId and chatModelOptions.
   * Returns AgentJobResult.
   */
  async runResume(
    configurable: RunContext,
    result: ResumeData,
    subagentId: string | undefined,
    chatModelOptions: ModelOptions
  ): Promise<AgentJobResult> {
    if (!this.compiledGraph) {
      throw new Error("ResumeWorker not started");
    }
    const runnable = await this.compiledGraph.getRunnable(subagentId, chatModelOptions);
    const resumePayload = { content: result.content };
    const state = await runnable.invoke(new Command({ resume: resumePayload }), { configurable });
    const [interrupt] = state?.["__interrupt__"] ?? [];
    if (interrupt) {
      return { status: "interrupted", interruptPayload: interrupt.value };
    }
    const messages = state.messages as BaseMessage[] | undefined;
    const lastAIMessageContent = getLastAIMessage(messages ?? [])?.content;
    return { status: "completed", lastMessage: lastAIMessageContent ? JSON.stringify(lastAIMessageContent) : undefined };
  }
}
