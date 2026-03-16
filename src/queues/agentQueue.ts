import { Queue, QueueOptions } from "bullmq";
import { QUEUE_NAMES } from "../options.js";
import type { AgentJobData, AgentJobResult } from "./types.js";

export function createAgentQueue(options: QueueOptions): Queue<AgentJobData, AgentJobResult> {
  return new Queue<AgentJobData, AgentJobResult>(QUEUE_NAMES.AGENT, { ...options });
}
