import { Queue, QueueOptions } from "bullmq";
import { QUEUE_NAMES } from "../options.js";
import type { ToolJobData } from "./types.js";

export function createToolsQueue(options: QueueOptions): Queue<ToolJobData> {
  return new Queue<ToolJobData>(QUEUE_NAMES.TOOLS, { ...options });
}
