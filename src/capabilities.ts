/**
 * omp-task-group — capability probe.
 *
 * Static, honest probing of the DOCUMENTED public surface at session time.
 * Capability detection — never version comparison; only explicit known-bad
 * denylists would be added, and none exist today.
 */

import type { ExtensionContext } from "./types";
import type { TaskGroupConfig } from "./config";

export const TASK_GROUP_POOL_PROC_CANCEL_CAPABILITY = "omp-task-group-pool-proc-cancel:v1";


export interface CapabilityRow {
  name: string;
  ok: boolean;
  /** "conditional" means public-surface support is known but requires runtime validation. */
  availability?: "available" | "conditional" | "unavailable";
  note?: string;
}

export interface CapabilityReport {
  rows: CapabilityRow[];
  /** True when the plugin can operate at all. */
  usable: boolean;
}

export function probeCapabilities(ctx: ExtensionContext | undefined, config: TaskGroupConfig): CapabilityReport {
  void ctx;
  const poolEnabled = config.execution.pool.enabled !== "off";
  const rows: CapabilityRow[] = [];

  rows.push({ name: "fanout", ok: true, note: "per-handle wait consumes each child result exactly once" });
  rows.push({ name: "all", ok: true });
  rows.push({ name: "any", ok: true });
  rows.push({ name: "quorum", ok: true });
  rows.push({ name: "structured", ok: true });
  rows.push({
    name: "summarize",
    ok: config.summarize.enabled,
    availability: config.summarize.enabled ? "available" : "unavailable",
    note: config.summarize.enabled ? undefined : "disabled by config (summarize.enabled=false)",
  });
  rows.push({
    name: "workpool",
    ok: true,
    availability: "conditional",
    note: "documented public Eval prelude; the active Eval binding and status/peek contract are checked before dispatch",
  });
  rows.push({
    name: "task-group-pool",
    ok: poolEnabled,
    availability: poolEnabled ? "conditional" : "unavailable",
    note: poolEnabled
      ? `candidate only: requires all+collect, homogeneous tasks, no per-task schema/isolation/concurrency override, and runtime preflight for competing jobs/live agents; every non-builtin Eval wrapper must declare ${TASK_GROUP_POOL_PROC_CANCEL_CAPABILITY} or Pool falls back to Fanout; existing services are handled as intermediate wait snapshots`
      : "disabled by config (execution.pool.enabled=off)",
  });
  rows.push({
    name: "eval-envelope",
    ok: true,
    note: "standard eval envelope ompTaskGroup(<strict JSON>); recognized via tool_call and finalized via tool_result — eval is not shadowed",
  });
  rows.push({
    name: "snapshot-details",
    ok: true,
    note: "final tool result details carry the stable omp-task-group/v1 snapshot shape; no live per-task stream",
  });

  const usable = rows.filter((r) => ["fanout", "all"].includes(r.name)).every((r) => r.ok);
  return { rows, usable };
}
