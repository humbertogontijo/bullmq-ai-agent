import { Queue, QueueOptions } from "bullmq";
import { QUEUE_NAMES } from "../options.js";
import type { SearchJobData } from "./types.js";

export function createSearchQueue(options: QueueOptions): Queue<SearchJobData> {
  return new Queue<SearchJobData>(QUEUE_NAMES.SEARCH, { ...options });
}
