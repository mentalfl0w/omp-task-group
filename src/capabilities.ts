/**
 * omp-task-group — capability probe.
 *
 * Static, honest probing of the DOCUMENTED public surface at session time.
 * Capability detection — never version comparison; only explicit known-bad
 * denylists would be added, and none exist today.
 */

import type { ExtensionContext } from "./types";
import type { TaskGroupConfig } from "./config";
import { scanAutoBackgroundConfig } from "./barriers";

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
  const poolEnabled = config.execution.pool.enabled !== "off";
  const barrier = ctx === undefined ? undefined : scanAutoBackgroundConfig(ctx.cwd, { mode: ctx.mode });
  const rows: CapabilityRow[] = [];

  rows.push({
    name: "background",
    ok: poolEnabled,
    availability: poolEnabled ? "conditional" : "unavailable",
    note: poolEnabled
      ? "explicit two-phase Workpool opt-in via background=\"require\" or execution.mode=\"background\"; the dispatch cell returns after verified push ids, OMP's native async-result notice signals completion, and an explicit ompTaskGroupCollect cell checks status/peek and writes one checksummed private file read with task_group_result; independent of eval.autoBackground"
      : "disabled by config (execution.pool.enabled=off); background requires the native Workpool path",
  });
  rows.push({
    name: "foreground-barrier",
    ok: barrier?.allow ?? true,
    availability: barrier === undefined ? "conditional" : barrier.allow ? "conditional" : "unavailable",
    note:
      barrier === undefined
        ? "no extension context; /task-group background inspects the active config, and foreground groups reject details.async"
        : [
            `state=${barrier.state}`,
            barrier.configured === undefined ? undefined : `configured=${barrier.configured}`,
            barrier.reason ?? "best-effort file scan; OMP has no public effective-settings query",
          ]
            .filter((part): part is string => part !== undefined)
            .join("; "),
  });
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
      ? `candidate only: requires all+collect, homogeneous tasks, no per-task schema/isolation/concurrency override; foreground Pool additionally preflights competing jobs/live agents before using wait(), while background dispatch never waits and is isolated by Workpool name; every non-builtin Eval wrapper must declare ${TASK_GROUP_POOL_PROC_CANCEL_CAPABILITY} or Pool falls back to Fanout`
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
