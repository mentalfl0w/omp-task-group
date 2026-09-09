/**
 * omp-task-group — foreground barrier guard.
 *
 * eval.autoBackground converts long cells into async jobs, which would break
 * the "one logical parent continuation" guarantee (the native tool returns
 * before children finish). We never toggle user settings; we detect configured
 * auto-background and fail closed. The envelope result decoder also rejects a
 * runtime `details.async` result.
 *
 * Detection is a documented-key scan of config.yml files (public settings
 * surface: eval.autoBackground.enabled / .thresholdMs). Absence of the key
 * means the default (false) — barrier safe.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BarrierCheck {
  safe: boolean;
  /** Human explanation when unsafe. */
  reason?: string;
  thresholdMs?: number;
}

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Minimal structured scan for the documented eval.autoBackground keys.
 * Returns enabled state + threshold if explicitly configured.
 */
export function scanAutoBackgroundConfig(cwd: string): BarrierCheck {
  const candidates = [join(homedir(), ".omp", "agent", "config.yml"), join(cwd, ".omp", "config.yml")];
  let enabled = false;
  let thresholdMs: number | undefined;
  for (const path of candidates) {
    const text = readIfPresent(path);
    if (text === undefined) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i]?.match(/^eval:\s*$/);
      if (!m) continue;
      // Walk the indented block beneath `eval:` until dedent.
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j] ?? "";
        if (line.trim().length > 0 && !/^\s/.test(line)) break;
        const ab = line.match(/^\s{2,}autoBackground:\s*$/);
        if (ab) {
          for (let k = j + 1; k < lines.length; k++) {
            const sub = lines[k] ?? "";
            if (sub.trim().length > 0 && /^\S/.test(sub)) break;
            const en = sub.match(/^\s+enabled:\s*(true|false)\s*$/);
            if (en) enabled = en[1] === "true";
            const th = sub.match(/^\s+thresholdMs:\s*(\d+)\s*$/);
            if (th) thresholdMs = Number(th[1]);
          }
        }
      }
    }
  }
  if (!enabled) return { safe: true };
  return {
    safe: false,
    thresholdMs,
    reason:
      "eval.autoBackground.enabled=true in config: long Task Group cells would convert to background jobs and return early, breaking the one-continuation guarantee",
  };
}
