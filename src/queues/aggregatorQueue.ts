import { Queue, QueueOptions } from "bullmq";
import { QUEUE_NAMES } from "../options.js";
import type { AggregatorJobData } from "./types.js";

export function createAggregatorQueue(options: QueueOptions): Queue<AggregatorJobData> {
  return new Queue<AggregatorJobData>(QUEUE_NAMES.AGGREGATOR, { ...options });
}
