/**
 * omp-task-group — configuration loader.
 *
 * Reads optional JSON config files (user + project overlay), validates once,
 * and returns the effective config. Unknown keys are ignored; invalid values
 * throw ConfigError with the offending path.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { validateConfig, defaultConfig, type TaskGroupConfig } from "./config";
import { isRecord } from "./guards";

export class ConfigLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigLoadError";
  }
}

function readJsonIfPresent(path: string): { raw: unknown; path: string } | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    return { raw: JSON.parse(text) as unknown, path };
  } catch (e) {
    throw new ConfigLoadError(`${path}: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** Load effective config: defaults ← user file ← project file. */
export function loadConfig(cwd: string, homeDir: string = homedir()): TaskGroupConfig {
  const userFile = readJsonIfPresent(join(homeDir, ".omp", "agent", "task-group.json"));
  const projectFile = readJsonIfPresent(join(cwd, ".omp", "task-group.json"));
  if (userFile === undefined && projectFile === undefined) return defaultConfig();

  const merged: Record<string, unknown> = {};
  for (const file of [userFile, projectFile]) {
    if (file === undefined) continue;
    if (!isRecord(file.raw)) throw new ConfigLoadError(`${file.path}: config root must be an object`);
    Object.assign(merged, file.raw);
  }
  try {
    return validateConfig(merged);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new ConfigLoadError(`${projectFile?.path ?? userFile?.path ?? "task-group config"}: ${message}`);
  }
}
