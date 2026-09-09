/**
 * omp-task-group — configuration.
 *
 * Config files (all optional, later overlays win):
 *   ~/.omp/agent/task-group.json   (user)
 *   <cwd>/.omp/task-group.json     (project)
 *
 * Architecture policy keys (privateApis/failClosed) are intentionally NOT
 * configurable: they are invariants of this plugin, not preferences.
 */

import type { FailureMode, JoinMode, OutputMode, Strategy } from "./schema/task-group";
import { isRecord } from "./guards";

export interface DispatcherConfig {
  mode: "off" | "suggest" | "enforce";
  detectMissedGroups: boolean;
}

export interface ExecutionConfig {
  strategy: "auto" | "fanout" | "pool";
  concurrency: "auto" | number;
  pool: {
    enabled: "auto" | "off";
    threshold: number;
    fallback: "fanout";
  };
}

export interface OutputConfig {
  mode: OutputMode;
  perTaskChars: number;
  maxTotalChars: number;
  preserveHandles: boolean;
}


export interface TelemetryConfig {
  enabled: boolean;
  detectMissedGroups: boolean;
}

export interface TaskGroupConfig {
  enabled: boolean;
  dispatcher: DispatcherConfig;
  execution: ExecutionConfig;
  join: { default: JoinMode };
  failure: { default: FailureMode };
  output: OutputConfig;
  summarize: {
    enabled: boolean;
    model: "smol" | "default" | "slow";
  };
  telemetry: TelemetryConfig;
}

export function defaultConfig(): TaskGroupConfig {
  return {
    enabled: true,
    dispatcher: { mode: "suggest", detectMissedGroups: true },
    execution: {
      strategy: "auto",
      concurrency: "auto",
      pool: { enabled: "auto", threshold: 6, fallback: "fanout" },
    },
    join: { default: "all" },
    failure: { default: "collect" },
    output: { mode: "compact", perTaskChars: 1200, maxTotalChars: 8000, preserveHandles: true },
    summarize: { enabled: false, model: "smol" },
    telemetry: { enabled: true, detectMissedGroups: true },
  };
}

const STRATEGIES: readonly Strategy[] = ["auto", "fanout", "pool"];
const JOIN_MODES: readonly JoinMode[] = ["all", "any", "quorum"];
const FAILURE_MODES: readonly FailureMode[] = ["collect", "fail_fast"];
const OUTPUT_MODES: readonly OutputMode[] = ["compact", "structured", "summarize"];

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string, fallback: T): T {
  if (value === undefined) return fallback;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new ConfigError(`${what} must be one of ${allowed.join(" | ")}`);
}

function intIn(value: unknown, what: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) return value;
  throw new ConfigError(`${what} must be an integer in [${min}, ${max}]`);
}

function bool(value: unknown, what: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  throw new ConfigError(`${what} must be a boolean`);
}

/** Apply one incoming section onto the config (mutates validated target). */
function mergeSection(
  raw: Record<string, unknown>,
  section: string,
  apply: (rec: Record<string, unknown>) => void,
): void {
  const sub = raw[section];
  if (sub === undefined) return;
  if (!isRecord(sub)) {
    throw new ConfigError(`task-group config.${section} must be an object`);
  }
  apply(sub);
}

/**
 * Validate a parsed JSON config object. Unknown keys are ignored (forward
 * compatible); invalid values throw ConfigError with a precise path.
 */
export function validateConfig(raw: unknown): TaskGroupConfig {
  const cfg = defaultConfig();
  if (raw === undefined || raw === null) return cfg;
  if (!isRecord(raw)) throw new ConfigError("task-group config root must be an object");

  cfg.enabled = bool(raw.enabled, "enabled", cfg.enabled);

  mergeSection(raw, "dispatcher", (d) => {
    cfg.dispatcher.mode = oneOf(d.mode, ["off", "suggest", "enforce"] as const, "dispatcher.mode", "suggest");
    cfg.dispatcher.detectMissedGroups = bool(d.detectMissedGroups, "dispatcher.detectMissedGroups", true);
  });
  mergeSection(raw, "execution", (e) => {
    cfg.execution.strategy = oneOf(e.strategy, STRATEGIES, "execution.strategy", "auto");
    if (e.concurrency !== undefined) {
      if (e.concurrency === "auto") cfg.execution.concurrency = "auto";
      else {
        const c = intIn(e.concurrency, "execution.concurrency", 1, 32, 0);
        cfg.execution.concurrency = c;
      }
    }
    if (e.pool !== undefined) {
      if (!isRecord(e.pool)) throw new ConfigError("execution.pool must be an object");
      cfg.execution.pool.enabled = oneOf(e.pool.enabled, ["auto", "off"] as const, "execution.pool.enabled", "auto");
      cfg.execution.pool.threshold = intIn(e.pool.threshold, "execution.pool.threshold", 2, 200, 6);
      cfg.execution.pool.fallback = oneOf(e.pool.fallback, ["fanout"] as const, "execution.pool.fallback", "fanout");
    }
  });
  mergeSection(raw, "join", (j) => {
    cfg.join.default = oneOf(j.default, JOIN_MODES, "join.default", "all");
  });
  mergeSection(raw, "failure", (f) => {
    cfg.failure.default = oneOf(f.mode ?? f.default, FAILURE_MODES, "failure.default", "collect");
  });
  mergeSection(raw, "output", (o) => {
    cfg.output.mode = oneOf(o.mode, OUTPUT_MODES, "output.mode", "compact");
    cfg.output.perTaskChars = intIn(o.perTaskChars, "output.perTaskChars", 100, 20000, 1200);
    cfg.output.maxTotalChars = intIn(o.maxTotalChars, "output.maxTotalChars", 500, 100000, 8000);
    cfg.output.preserveHandles = bool(o.preserveHandles, "output.preserveHandles", true);
    if (cfg.output.maxTotalChars < cfg.output.perTaskChars) {
      throw new ConfigError("output.maxTotalChars must be >= output.perTaskChars");
    }
  });
  mergeSection(raw, "summarize", (s) => {
    cfg.summarize.enabled = bool(s.enabled, "summarize.enabled", false);
    cfg.summarize.model = oneOf(s.model, ["smol", "default", "slow"] as const, "summarize.model", "smol");
  });
  mergeSection(raw, "telemetry", (t) => {
    cfg.telemetry.enabled = bool(t.enabled, "telemetry.enabled", true);
    cfg.telemetry.detectMissedGroups = bool(t.detectMissedGroups, "telemetry.detectMissedGroups", true);
  });

  return cfg;
}
