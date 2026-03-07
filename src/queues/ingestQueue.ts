import { Queue, QueueOptions } from "bullmq";
import { QUEUE_NAMES } from "../options.js";
import type { IngestJobData } from "./types.js";

export function createIngestQueue(options: QueueOptions): Queue<IngestJobData> {
  return new Queue<IngestJobData>(QUEUE_NAMES.INGEST, { ...options });
}
