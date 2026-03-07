import type { RedisSaver } from "../redis/RedisSaver.js";
import { buildOrchestratorGraph, type OrchestratorContext } from "./orchestrator.js";

export type CompileGraphOptions = OrchestratorContext & {
  checkpointer: RedisSaver;
};

export async function compileGraph(ctx: CompileGraphOptions) {
  const builder = buildOrchestratorGraph(ctx);
  return builder.compile({ checkpointer: ctx.checkpointer });
}

export type CompiledGraph = Awaited<ReturnType<typeof compileGraph>>;
