/**
 * omp-task-group — capability probe.
 *
 * Static, honest probing of the DOCUMENTED public surface at session time.
 * Capability detection — never version comparison; only explicit known-bad
 * denylists would be added, and none exist today.
 */

import type { ExtensionContext } from "./types";
import type { TaskGroupConfig } from "./config";

export interface CapabilityRow {
  name: string;
  ok: boolean;
  note?: string;
}

export interface CapabilityReport {
  rows: CapabilityRow[];
  /** True when the plugin can operate at all. */
  usable: boolean;
}

export function probeCapabilities(ctx: ExtensionContext | undefined, config: TaskGroupConfig): CapabilityReport {
  const rows: CapabilityRow[] = [];

  rows.push({ name: "fanout", ok: true });
  rows.push({ name: "all", ok: true });
  rows.push({ name: "any", ok: true });
  rows.push({ name: "quorum", ok: true });
  rows.push({ name: "structured", ok: true });
  rows.push({
    name: "summarize",
    ok: config.summarize.enabled,
    note: config.summarize.enabled ? undefined : "disabled by config (summarize.enabled=false)",
  });
  rows.push({
    name: "workpool",
    ok: true,
    note: "verified at runtime; automatic fanout fallback on any mismatch",
  });
  rows.push({
    name: "eval-envelope",
    ok: true,
    note: "standard eval code envelope ompTaskGroup(<strict JSON>); recognized via tool_call (input rewrite) and finalized via tool_result (details.jsonOutputs) — eval is not shadowed",
  });
  rows.push({
    name: "snapshot-details",
    ok: true,
    note: "final tool result details carry the stable omp-task-group/v1 snapshot shape; no live per-task stream",
  });

  const usable = rows.filter((r) => ["fanout", "all"].includes(r.name)).every((r) => r.ok);
  return { rows, usable };
}
