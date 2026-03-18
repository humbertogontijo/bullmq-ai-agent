import type { AgentConfig } from "../options.js";
import { buildOrchestratorRunnables, type CompileGraphOptions } from "./orchestrator.js";
import type { OrchestratorRunnables } from "./orchestrator.js";

/** Return type of compileGraph (explicit to avoid pulling in deepagents/langchain in inferred type). */
export interface CompiledGraph extends OrchestratorRunnables {
  getAgentConfig?: (agentId: string) => Promise<AgentConfig | undefined>;
  /** When true, this subagent's runs are not committed to the thread (no ZADD to thread-jobs). Used for suggestions, reply-draft, etc. */
  isEphemeralSubagent?: (subagentId: string) => boolean;
}

export async function compileGraph(ctx: CompileGraphOptions): Promise<CompiledGraph> {
  const subagents = ctx.subagents;
  return {
    ...buildOrchestratorRunnables(ctx),
    getAgentConfig: ctx.getAgentConfig,
    isEphemeralSubagent:
      subagents?.length
        ? (subagentId: string) => subagents.find((s) => s.name === subagentId)?.ephemeral === true
        : undefined,
  };
}
