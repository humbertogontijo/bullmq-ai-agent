import { Queue, QueueOptions } from "bullmq";
import { QUEUE_NAMES } from "../options.js";
import type { AgentJobData } from "./types.js";

export function createAgentQueue(options: QueueOptions): Queue<AgentJobData> {
  return new Queue<AgentJobData>(QUEUE_NAMES.AGENT, { ...options });
}
