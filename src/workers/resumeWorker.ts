import type { BaseMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { CompiledGraph } from "../agent/compile.js";
import type { RunContext } from "../options.js";
import type { AgentJobResult } from "../queues/types.js";
import { getLastAIMessage } from "../utils/message.js";

export interface ResumeWorkerParams {
  compiledGraph: CompiledGraph;
}

/**
 * Holds the compiled graph and shared resume logic. Created once in BullMQAgentWorker
 * and passed to AgentWorker and AggregatorWorker so they share the same graph instance.
 */
export class ResumeWorker {
  private readonly compiledGraph: CompiledGraph;
  private _started = false;

  constructor(params: ResumeWorkerParams) {
    this.compiledGraph = params.compiledGraph;
  }

  /** Compiles the graph lazily and returns it. Used by AgentWorker for "run" and by both for resume. */
  async start() {
    if (this._started) return;
  }

  /** Runs the shared resume flow using the stored graph. Returns AgentJobResult. */
  async runResume(configurable: RunContext, result: unknown): Promise<AgentJobResult> {
    if (!this.compiledGraph) {
      throw new Error("ResumeWorker not started");
    }
    // Single invoke: Command(resume) loads checkpoint, applies human input, then continues to END (or next interrupt).
    const state = await this.compiledGraph.invoke(new Command({ resume: result }), { configurable });
    const interrupts = state?.["__interrupt__"];
    if (interrupts?.length) {
      return { status: "interrupted", interruptPayload: interrupts[0].value };
    }
    const messages = state.messages as BaseMessage[] | undefined;
    const lastAIMessageContent = getLastAIMessage(messages ?? [])?.content;
    return { status: "completed", lastMessage: lastAIMessageContent ? JSON.stringify(lastAIMessageContent) : undefined };
  }
}
