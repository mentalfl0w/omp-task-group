/**
 * omp-task-group — eval.autoBackground configuration diagnosis.
 *
 * Foreground groups need `eval.autoBackground.enabled` to be disabled: OMP can
 * auto-background a native Eval cell and deliver its output later as a separate
 * `async-result` custom message, which the foreground one-result contract
 * cannot decode. Explicit background groups are the opposite case: they are
 * admissible only when the effective setting is confirmed `enabled=true` with
 * `thresholdMs=0`, so long cells reliably become async jobs.
 *
 * This module is a best-effort *configuration* check, not a guarantee. It scans
 * the documented settings surfaces that can configure `eval.autoBackground`, in
 * precedence order:
 *
 *   - global `config.yml` / `config.yaml` under the active agent directory
 *     (`PI_CODING_AGENT_DIR`; a named profile uses
 *     `~/.omp/profiles/<name>/agent` instead and ignores that variable);
 *   - project `.omp/settings.json`, then `.omp/config.yml` (which overrides
 *     `settings.json`), then `.claude/settings.json`;
 *   - `PI_CONFIG_FILES` overlays;
 *   - `--config <file>` / `--config=<file>` overlays.
 *
 * Each key is resolved independently: an unreadable layer is only ignored when
 * a later layer demonstrably overrides that key. OMP's setting default is
 * `false` in every mode; RPC pins that same setting default instead of
 * supplying a different one. OMP exposes no public extension API for the
 * *effective* setting, so runtime changes are not observable. Foreground
 * groups still fail closed on `details.async`; background groups only trust the
 * checksummed result file written by their compiled cell.
 *
 * The plugin never mutates user settings.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { isRecord } from "./guards";
import type { ExtensionMode } from "./types";

export interface BarrierScanOptions {
  /** Extension run mode (`ctx.mode`). Recorded for diagnosis; OMP's auto-background setting default is false in every mode. */
  mode?: ExtensionMode | string;
  /** Command-line arguments; defaults to process.argv.slice(1) so native-binary argv is not truncated. */
  argv?: readonly string[];
  /** Environment used for PI_CONFIG_FILES / agent directory resolution. */
  env?: Record<string, string | undefined>;
  /** Home directory used for the default `~/.omp/agent` path. */
  homeDir?: string;
}

export interface AutoBackgroundSource {
  path: string;
  layer: "global" | "project" | "overlay";
  status: "read" | "error";
  enabled?: boolean;
  thresholdMs?: number;
  detail?: string;
}

export interface BarrierCheck {
  /** Foreground groups may run; false means a foreground native cell cannot be assured. */
  allow: boolean;
  /** Explicit background opt-in is admissible: enabled=true and thresholdMs=0 are confirmed. */
  backgroundReady: boolean;
  state: "disabled" | "enabled" | "unknown";
  /** Value found in the inspected configuration layers, if any. */
  configured?: boolean;
  /** OMP's setting default when no inspected layer configures it (false in every mode; RPC pins that same default). */
  defaultEnabled: boolean;
  /** True when the resolved configuration explicitly disables auto-background. */
  configuredDisabled: boolean;
  /** Resolved effective threshold, only when no higher-precedence layer is unresolved. */
  thresholdMs?: number;
  /** Explanation when foreground `allow` is false. */
  reason?: string;
  /** Why explicit background is or is not available. Always present. */
  backgroundReason: string;
  /** Every inspected config source, including ones that failed to parse. */
  sources: AutoBackgroundSource[];
  /** Uncertainties that prevent treating this scan as a guarantee. */
  warnings: string[];
  /** Effective mode recorded for diagnosis. */
  mode: string;
}

interface BunYamlGlobal {
  YAML?: { parse(text: string): unknown };
}

const MAIN_CONFIG_FILENAMES = ["config.yml", "config.yaml"] as const;

function readText(path: string): { status: "missing" } | { status: "error"; detail: string } | { status: "read"; text: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { status: "missing" };
    return { status: "error", detail: error instanceof Error ? error.message : String(error) };
  }
  return { status: "read", text };
}

function parseYaml(text: string): unknown {
  // Bun.YAML is a documented Bun global; @types/bun may not expose this field yet.
  const runtime = globalThis as unknown as { Bun?: BunYamlGlobal };
  const yaml = runtime.Bun?.YAML;
  if (yaml === undefined || yaml.parse === undefined) {
    throw new Error(
      "no Bun.YAML parser is available; cannot read YAML settings (this plugin targets the Bun runtime used by OMP)",
    );
  }
  return yaml.parse(text);
}

function getPath(root: Record<string, unknown>, segments: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

interface AutoBackgroundValues {
  enabled?: boolean;
  thresholdMs?: number;
  error?: string;
}

/**
 * Extract the documented keys from an already-parsed config object. Flat
 * dotted keys are accepted because some settings shims serialize them that way;
 * malformed values become an explicit unresolved source instead of a guess.
 */
function extractAutoBackground(raw: unknown): AutoBackgroundValues {
  if (raw === null || raw === undefined) return {};
  if (!isRecord(raw)) return { error: "config root is not an object" };

  const nestedEnabled = getPath(raw, ["eval", "autoBackground", "enabled"]);
  const nestedThreshold = getPath(raw, ["eval", "autoBackground", "thresholdMs"]);
  const flatEnabled = raw["eval.autoBackground.enabled"];
  const flatThreshold = raw["eval.autoBackground.thresholdMs"];
  const enabledRaw = nestedEnabled !== undefined ? nestedEnabled : flatEnabled;
  const thresholdRaw = nestedThreshold !== undefined ? nestedThreshold : flatThreshold;

  const out: AutoBackgroundValues = {};
  if (enabledRaw !== undefined) {
    if (typeof enabledRaw !== "boolean") {
      return { error: "eval.autoBackground.enabled must be a boolean" };
    }
    out.enabled = enabledRaw;
  }
  if (thresholdRaw !== undefined) {
    if (typeof thresholdRaw !== "number" || !Number.isFinite(thresholdRaw) || thresholdRaw < 0) {
      return { error: "eval.autoBackground.thresholdMs must be a non-negative number" };
    }
    out.thresholdMs = thresholdRaw;
  }
  return out;
}

function sourceForFile(
  path: string,
  layer: AutoBackgroundSource["layer"],
  required: boolean,
): AutoBackgroundSource | undefined {
  const read = readText(path);
  if (read.status === "missing") {
    if (!required) return undefined;
    return { path, layer, status: "error", detail: "file is missing" };
  }
  if (read.status === "error") {
    return { path, layer, status: "error", detail: read.detail };
  }

  let parsed: unknown;
  try {
    parsed = path.endsWith(".json") ? JSON.parse(read.text) : parseYaml(read.text);
  } catch (error) {
    return {
      path,
      layer,
      status: "error",
      detail: `could not parse config: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const values = extractAutoBackground(parsed);
  if (values.error !== undefined) {
    return { path, layer, status: "error", detail: values.error };
  }
  const source: AutoBackgroundSource = { path, layer, status: "read" };
  if (values.enabled !== undefined) source.enabled = values.enabled;
  if (values.thresholdMs !== undefined) source.thresholdMs = values.thresholdMs;
  return source;
}

function expandHome(path: string, homeDir: string): string {
  if (path === "~") return homeDir;
  if (path.startsWith("~/")) return join(homeDir, path.slice(2));
  return path;
}

function cliOverlayPaths(argv: readonly string[], cwd: string, homeDir: string): string[] {
  const out: string[] = [];
  let takeNext = false;
  let flagsEnded = false;
  for (const arg of argv) {
    if (flagsEnded) continue;
    if (arg === "--") {
      flagsEnded = true;
      continue;
    }
    if (takeNext) {
      out.push(resolve(cwd, expandHome(arg, homeDir)));
      takeNext = false;
      continue;
    }
    if (arg === "--config") {
      takeNext = true;
      continue;
    }
    if (arg.startsWith("--config=")) {
      const value = arg.slice("--config=".length);
      if (value.length > 0) out.push(resolve(cwd, expandHome(value, homeDir)));
    }
  }
  return out;
}

function activeProfileName(argv: readonly string[], env: Record<string, string | undefined>): string | undefined {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--") break;
    if (arg === "--profile") {
      const next = argv[index + 1];
      if (next !== undefined && next !== "--" && next.length > 0) return next;
    }
    if (arg.startsWith("--profile=")) {
      const value = arg.slice("--profile=".length);
      if (value.length > 0) return value;
    }
  }
  const envProfile = (env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE)?.trim();
  return envProfile !== undefined && envProfile.length > 0 ? envProfile : undefined;
}

function describeSource(source: AutoBackgroundSource): string {
  const parts: string[] = [source.layer];
  if (source.status === "error") {
    parts.push(`error: ${source.detail ?? "unknown error"}`);
    return parts.join(", ");
  }
  if (source.enabled === undefined && source.thresholdMs === undefined) {
    parts.push("no eval.autoBackground keys");
  } else {
    if (source.enabled !== undefined) parts.push(`enabled=${source.enabled}`);
    if (source.thresholdMs !== undefined) parts.push(`thresholdMs=${source.thresholdMs}`);
  }
  return parts.join(", ");
}

/**
 * Best-effort scan of every discoverable documentation-level configuration
 * layer. `allow: false` means a foreground group is blocked: auto-background
 * is known enabled, or a higher-precedence layer could enable it and could not
 * be read. `backgroundReady` is true only when enabled=true and thresholdMs=0
 * are both resolved without a later unreadable layer.
 */
export function scanAutoBackgroundConfig(cwd: string, options: BarrierScanOptions = {}): BarrierCheck {
  const mode = options.mode ?? "unknown";
  const argv = options.argv ?? process.argv.slice(1);
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();

  const sources: AutoBackgroundSource[] = [];
  const warnings: string[] = [];

  const explicitAgentDir =
    typeof env.PI_CODING_AGENT_DIR === "string" && env.PI_CODING_AGENT_DIR.trim().length > 0
      ? env.PI_CODING_AGENT_DIR
      : undefined;
  const profileName = activeProfileName(argv, env);
  const namedProfile = profileName !== undefined && profileName !== "default" ? profileName : undefined;
  const configDirName =
    typeof env.PI_CONFIG_DIR === "string" && env.PI_CONFIG_DIR.trim().length > 0 ? env.PI_CONFIG_DIR : ".omp";
  const derivedAgentDir = join(
    homeDir,
    configDirName,
    ...(namedProfile !== undefined ? ["profiles", namedProfile, "agent"] : ["agent"]),
  );
  // OMP ignores PI_CODING_AGENT_DIR while a named profile is active: the
  // profile's agent directory wins even when the variable points elsewhere.
  const agentDir = namedProfile !== undefined ? derivedAgentDir : explicitAgentDir ?? derivedAgentDir;

  const globalPath = MAIN_CONFIG_FILENAMES.map((name) => join(agentDir, name)).find((path) => existsSync(path));
  if (globalPath !== undefined) {
    const source = sourceForFile(globalPath, "global", false);
    if (source !== undefined) sources.push(source);
  }

  const projectConfigDir = join(cwd, ".omp");
  const projectPaths = [
    // OMP merges `.omp/settings.json` first and `.omp/config.yml` after it,
    // so the YAML file overrides the JSON file when both set the same key.
    join(projectConfigDir, "settings.json"),
    join(projectConfigDir, "config.yml"),
    join(cwd, ".claude", "settings.json"),
  ];
  for (const path of projectPaths) {
    const source = sourceForFile(path, "project", false);
    if (source !== undefined) sources.push(source);
  }

  const envOverlays = (env.PI_CONFIG_FILES ?? "")
    .split(delimiter)
    .filter((path) => path.length > 0)
    .map((path) => resolve(cwd, expandHome(path, homeDir)));
  const overlays = [...envOverlays, ...cliOverlayPaths(argv, cwd, homeDir)];
  const seenOverlays = new Set<string>();
  for (const path of overlays) {
    if (seenOverlays.has(path)) continue;
    seenOverlays.add(path);
    const source = sourceForFile(path, "overlay", true);
    if (source !== undefined) sources.push(source);
  }

  let configured: boolean | undefined;
  let enabledIndex = -1;
  let thresholdValue: number | undefined;
  let thresholdIndex = -1;
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index];
    if (source === undefined || source.status !== "read") continue;
    if (source.enabled !== undefined) {
      configured = source.enabled;
      enabledIndex = index;
    }
    if (source.thresholdMs !== undefined) {
      thresholdValue = source.thresholdMs;
      thresholdIndex = index;
    }
  }

  // A layer that could not be read is only harmless when a later layer
  // demonstrably overrides the same key. Any error at or after the last known
  // writer leaves that key unresolved.
  const unresolvedAfter = (index: number): AutoBackgroundSource[] =>
    sources.filter((source, sourceIndex) => source.status === "error" && sourceIndex > index);
  const enabledUnresolved = unresolvedAfter(enabledIndex);
  const thresholdUnresolved = unresolvedAfter(thresholdIndex);
  const unresolvedDetail = (errors: AutoBackgroundSource[]): string =>
    errors.map((source) => `${source.path}: ${source.detail ?? "unreadable"}`).join("; ");

  // OMP's setting default is false in every mode; RPC pins this same default
  // as an override instead of enabling auto-background.
  const defaultEnabled = false;
  let state: BarrierCheck["state"];
  let reason: string | undefined;

  if (enabledIndex >= 0) {
    if (enabledUnresolved.length > 0) {
      state = "unknown";
      reason =
        "a higher-precedence configuration layer could not be read, so the effective eval.autoBackground.enabled value is unknown (" +
        unresolvedDetail(enabledUnresolved) +
        ")";
    } else {
      state = configured ? "enabled" : "disabled";
    }
  } else if (sources.some((source) => source.status === "error")) {
    state = "unknown";
    reason =
      "eval.autoBackground.enabled was not found in any readable configuration layer, and at least one settings source could not be inspected (" +
      unresolvedDetail(sources.filter((source) => source.status === "error")) +
      ")";
  } else {
    state = "disabled";
  }

  const thresholdMs =
    thresholdIndex >= 0 && thresholdUnresolved.length === 0 ? thresholdValue : undefined;
  const thresholdKnown = thresholdMs !== undefined;

  let backgroundReason: string;
  if (state === "unknown") {
    backgroundReason =
      "autoBackground readiness (foreground-protection scan) requires a confirmed eval.autoBackground.enabled=true and thresholdMs=0, but the effective value is unknown" +
      (reason !== undefined ? ` (${reason})` : "");
  } else if (state === "disabled") {
    const source = sources[enabledIndex];
    backgroundReason =
      configured === false
        ? `eval.autoBackground.enabled is explicitly false in ${source?.path ?? "settings"}`
        : "eval.autoBackground.enabled is not configured and OMP defaults to false";
  } else if (thresholdIndex < 0) {
    backgroundReason =
      "eval.autoBackground.enabled=true, but thresholdMs is not configured; readiness requires an explicit thresholdMs=0";
  } else if (!thresholdKnown) {
    backgroundReason =
      "eval.autoBackground.enabled=true, but thresholdMs could not be resolved because a higher-precedence layer is unreadable (" +
      unresolvedDetail(thresholdUnresolved) +
      ")";
  } else if (thresholdMs !== 0) {
    backgroundReason = `eval.autoBackground.enabled=true, but thresholdMs=${thresholdMs}; readiness requires thresholdMs=0`;
  } else {
    const enabledSource = sources[enabledIndex]?.path ?? "settings";
    const thresholdSource = sources[thresholdIndex]?.path ?? enabledSource;
    backgroundReason =
      `foreground-protection readiness: eval.autoBackground.enabled=true is confirmed in ${enabledSource}, and thresholdMs=0 is confirmed in ${thresholdSource}`;
  }

  if (state === "enabled" && reason === undefined) {
    const source = sources[enabledIndex];
    reason = `eval.autoBackground.enabled=true in ${source?.path ?? "settings"}${
      thresholdMs !== undefined ? ` (thresholdMs=${thresholdMs})` : ""
    }`;
  }

  warnings.push(
    "OMP exposes no public extension API for the effective eval.autoBackground value; this is a best-effort file scan. Runtime settings changes are not observable, and foreground groups fail closed if `tool_result` reports details.async.",
  );
  warnings.push(
    "This scan only protects foreground groups from host auto-backgrounding; the explicit two-phase Workpool background path does not read eval.autoBackground and is not gated by this readiness value.",
  );

  const allow = state === "disabled";
  const backgroundReady = state === "enabled" && thresholdKnown && thresholdMs === 0;
  return {
    allow,
    backgroundReady,
    state,
    ...(configured !== undefined ? { configured } : {}),
    defaultEnabled,
    configuredDisabled: configured === false,
    ...(thresholdMs !== undefined ? { thresholdMs } : {}),
    ...(reason !== undefined ? { reason } : {}),
    backgroundReason,
    sources,
    warnings,
    mode,
  };
}

/** Human-readable diagnosis shared by the block reason and /task-group background. */
export function formatBarrierDiagnosis(check: BarrierCheck): string {
  const lines = [
    `Foreground requirement: ${check.allow ? "satisfied (best effort)" : "not satisfied"}`,
    `eval.autoBackground readiness (foreground-protection scan; two-phase background does not require it): ${
      check.backgroundReady ? "available (best effort)" : "unavailable"
    }`,
    `Extension mode: ${check.mode}`,
    `autoBackground setting default: ${check.defaultEnabled ? "enabled" : "disabled"}`,
    `Inspected state: ${check.state}${
      check.configured === undefined ? "" : ` (explicitly configured ${check.configured})`
    }`,
  ];
  if (check.thresholdMs !== undefined) lines.push(`Resolved thresholdMs: ${check.thresholdMs}`);
  lines.push(`Background: ${check.backgroundReason}`);
  if (check.sources.length === 0) {
    lines.push("Config sources: none found");
  } else {
    lines.push("Config sources:");
    for (const source of check.sources) lines.push(`- ${source.path} — ${describeSource(source)}`);
  }
  if (check.warnings.length > 0) {
    lines.push("Uncertainty:");
    for (const warning of check.warnings) lines.push(`- ${warning}`);
  }
  if (!check.allow && check.reason !== undefined) lines.push(`Foreground blocker: ${check.reason}`);
  return lines.join("\n");
}
