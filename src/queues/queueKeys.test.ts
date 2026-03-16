import { describe, it, expect } from "vitest";
import {
  DEFAULT_QUEUE_PREFIX,
  getQueueKeyPrefix,
  buildJobIdPrefix,
  buildThreadScanPattern,
  buildThreadJobsKey,
} from "./queueKeys.js";

describe("queueKeys", () => {
  describe("DEFAULT_QUEUE_PREFIX", () => {
    it("is bull", () => {
      expect(DEFAULT_QUEUE_PREFIX).toBe("bull");
    });
  });

  describe("getQueueKeyPrefix", () => {
    it("returns default when prefix is undefined", () => {
      expect(getQueueKeyPrefix(undefined)).toBe("bull");
    });
    it("returns custom prefix when provided", () => {
      expect(getQueueKeyPrefix("myapp")).toBe("myapp");
    });
  });

  describe("buildJobIdPrefix", () => {
    it("returns prefix:queueName:", () => {
      expect(buildJobIdPrefix("bull", "agent")).toBe("bull:agent:");
      expect(buildJobIdPrefix("myapp", "ingest")).toBe("myapp:ingest:");
    });
  });

  describe("buildThreadScanPattern", () => {
    it("returns jobIdPrefix + threadId + /*", () => {
      expect(buildThreadScanPattern("bull", "agent", "t1")).toBe("bull:agent:t1/*");
      expect(buildThreadScanPattern("myapp", "agent", "thread-123")).toBe("myapp:agent:thread-123/*");
    });
  });

  describe("buildThreadJobsKey", () => {
    it("returns prefix:queueName:thread-jobs:threadId (keyed by threadId only)", () => {
      expect(buildThreadJobsKey("bull", "agent", "t1")).toBe("bull:agent:thread-jobs:t1");
      expect(buildThreadJobsKey("myapp", "agent", "thread-123")).toBe("myapp:agent:thread-jobs:thread-123");
    });
  });
});
