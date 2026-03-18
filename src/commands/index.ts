/**
 * Redis/Lua command scripts. Each script is read from src/commands/*.lua at runtime.
 * Build copies .lua files to dist/commands so they are available when running from dist.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const getPreviousReturnvaluesScript = readFileSync(
  join(__dirname, "getPreviousReturnvalues.lua"),
  "utf8"
);

export const getLastJobAndReturnvalueScript = readFileSync(
  join(__dirname, "getLastJobAndReturnvalue.lua"),
  "utf8"
);

export const clearThreadJobsAndRemoveJobsScript = readFileSync(
  join(__dirname, "clearThreadJobsAndRemoveJobs.lua"),
  "utf8"
);

export const saveMemoryScript = readFileSync(
  join(__dirname, "saveMemory.lua"),
  "utf8"
);

export const getMemoriesScript = readFileSync(
  join(__dirname, "getMemories.lua"),
  "utf8"
);

export const deleteMemoryScript = readFileSync(
  join(__dirname, "deleteMemory.lua"),
  "utf8"
);

export const clearMemoriesScript = readFileSync(
  join(__dirname, "clearMemories.lua"),
  "utf8"
);
