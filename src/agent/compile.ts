import type { AgentConfig } from "../options.js";
import { buildOrchestratorRunnables, type CompileGraphOptions } from "./orchestrator.js";
import type { OrchestratorRunnables } from "./orchestrator.js";

/** Return type of compileGraph (explicit to avoid pulling in deepagents/langchain in inferred type). */
export interface CompiledGraph extends OrchestratorRunnables {
  getAgentConfig?: (agentId: string) => Promise<AgentConfig | undefined>;
  getSkillsPrompt?: () => string;
}

/** Returns the "Available skills" system prompt block when skills are configured. */
function getSkillsPrompt(skills: { name: string; description: string }[]): string {
  const lines = skills.map((s) => `- **${s.name}**: ${s.description}`).join("\n");
  return `\n\n## Available Skills\n\n${lines}\n\nUse the load_skill tool when you need detailed information about a specific skill.`;
}

export async function compileGraph(ctx: CompileGraphOptions): Promise<CompiledGraph> {
  const skills = ctx.skills;
  return {
    ...buildOrchestratorRunnables(ctx),
    getAgentConfig: ctx.getAgentConfig,
    getSkillsPrompt:
      skills?.length ?
        () => getSkillsPrompt(skills)
      : undefined,
  };
}
