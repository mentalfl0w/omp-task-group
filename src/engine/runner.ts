/**
 * omp-task-group — engine runner.
 *
 * One public entry: runTaskGroup(). Owns the lifecycle PLAN → SPAWN → RUN →
 * JOIN → AGGREGATE → RETURN, the snapshot reducer, update throttling, the
 * Result Gate and telemetry emission. The only OMP surface it touches is the
 * backend (public eval prelude) and caller-provided telemetry.
 */

import type { BackendRunCallbacks, GroupRunResult, TaskGroupBackend } from "../backend/interface";
import type { TaskGroupSpec } from "../schema/task-group";
import type { TaskGroupConfig } from "../config";
import { planExecution, type PlanResult } from "./planner";
import { SnapshotReducer, initialSnapshot } from "./reducer";
import type { GroupEvent, TaskGroupSnapshot } from "../state/events";
import { runResultGate } from "../result/gate";
import { renderSnapshotText } from "../presentation/text";
import type { ToolUpdateCallback } from "../types";

export interface TelemetrySink {
  recordGroup(entry: TelemetryGroupEntry): void;
}

export interface TelemetryGroupEntry {
  groupId: string;
  strategy: "fanout" | "pool";
  fallbackReason?: string;
  join: TaskGroupSpec["join"];
  failure: TaskGroupSpec["failure"];
  taskCount: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  rawChildChars: number;
  deliveredChars: number;
  groupDurationMs: number;
  estimatedWakesAvoided: number;
  barrierViolated?: string;
  planReasons: string[];
}

export interface RunOutcome {
  /** Final text content block for the tool result. */
  text: string;
  /** Machine-readable details (protocol + snapshot). */
  details: Record<string, unknown>;
  isError: boolean;
  snapshot: TaskGroupSnapshot;
  plan: PlanResult;
  gateMode: "compact" | "structured" | "summarize";
}

export function newGroupId(): string {
  const rand = Math.floor(Math.random() * 1e6).toString(36);
  return `tg${Date.now().toString(36)}${rand}`;
}

export async function runTaskGroup(args: {
  spec: TaskGroupSpec;
  config: TaskGroupConfig;
  backend: TaskGroupBackend;
  signal: AbortSignal | undefined;
  onUpdate: ToolUpdateCallback | undefined;
  telemetry: TelemetrySink;
  /** Reuse preparation-time identifiers for hook-based execution. */
  groupId?: string;
  plan?: PlanResult;
  /** Live presenter hook: called on every throttled/immediate snapshot emit. */
  onSnapshot?: ((snapshot: TaskGroupSnapshot) => void) | undefined;
}): Promise<RunOutcome> {
  const { spec, config, backend, signal, onUpdate, telemetry, onSnapshot } = args;
  const groupId = args.groupId ?? newGroupId();
  const plan =
    args.plan ??
    planExecution(spec, backend.capabilities(), {
      enabled: config.execution.pool.enabled,
      threshold: config.execution.pool.threshold,
    });
  const snapshot0 = initialSnapshot(
    groupId,
    spec.label,
    plan.strategy,
    plan.strategy === "pool" ? { mode: spec.join.mode } : spec.join,
    spec.failure,
    spec.tasks.map((t) => ({ name: t.name, agent: t.agent })),
    plan.fallbackReason,
  );
  const reducer = new SnapshotReducer(snapshot0);

  const startedEvent: GroupEvent = {
    type: "group_started",
    groupId,
    label: spec.label,
    strategy: plan.strategy,
    fallbackReason: plan.fallbackReason,
    join: plan.strategy === "pool" ? { mode: spec.join.mode } : spec.join,
    failure: spec.failure,
    taskNames: spec.tasks.map((t) => ({ name: t.name, agent: t.agent })),
    startedAtMs: snapshot0.startedAtMs,
  };
  reducer.apply(startedEvent);

  const emitNow = (): void => {
    const snap = reducer.current;
    onUpdate?.({
      content: [{ type: "text", text: renderSnapshotText(snap) }],
      details: { protocol: snap.protocol, snapshot: snap },
    });
    onSnapshot?.(snap);
  };

  const callbacks: BackendRunCallbacks = {
    onEvent: (event) => {
      reducer.apply(event);
      emitNow();
    },
    onProgressLine: () => {
      // The envelope backend has no marker stream; preserve this no-op seam
      // for a future public backend that emits diagnostics separately.
    },
  };

  let result: GroupRunResult;
  try {
    result = await backend.runGroup(spec, groupId, plan.strategy, callbacks, signal);
  } catch (e) {
    // Backend threw outside marker transport — mark the group failed whole.
    const duration = Date.now() - snapshot0.startedAtMs;
    const snapshot = reducer.finalize("failed", duration);
    const message = e instanceof Error ? e.message : String(e);
    return {
      text: `Task Group failed: ${message}`,
      details: { protocol: snapshot.protocol, snapshot, error: message },
      isError: true,
      snapshot,
      plan,
      gateMode: "compact",
    };
  }

  // Fold final outcomes into the snapshot (covers events the program skipped).
  for (const o of result.outcomes) {
    reducer.apply({
      type: "task_state",
      name: o.name,
      state: o.status === "missing" ? "failed" : o.status,
      handle: o.handle,
      durationMs: o.durationMs,
      error: o.error,
    });
  }

  const groupState: TaskGroupSnapshot["state"] = result.cancelled
    ? "cancelled"
    : result.groupError !== undefined
      ? "failed"
      : "completed";
  const durationMs = Date.now() - snapshot0.startedAtMs;
  const snapshot = reducer.finalize(groupState, durationMs);

  const settledChildren = snapshot.counts.succeeded + snapshot.counts.failed + snapshot.counts.cancelled;
  const estimatedWakesAvoided = Math.max(0, settledChildren - 1);
  snapshot.metrics.rawChildChars = result.rawChildChars;
  snapshot.metrics.estimatedWakesAvoided = estimatedWakesAvoided;

  const gate = runResultGate(result.outcomes, spec, { groupState, groupError: result.groupError, summary: result.summary });
  snapshot.metrics.deliveredChars = gate.deliveredChars;
  if (result.barrierViolated !== undefined) snapshot.fallbackReason = result.barrierViolated;

  telemetry.recordGroup({
    groupId,
    strategy: result.strategy,
    fallbackReason: result.fallbackReason ?? plan.fallbackReason,
    join: spec.join,
    failure: spec.failure,
    taskCount: spec.tasks.length,
    succeeded: snapshot.counts.succeeded,
    failed: snapshot.counts.failed,
    cancelled: snapshot.counts.cancelled,
    rawChildChars: result.rawChildChars,
    deliveredChars: gate.deliveredChars,
    groupDurationMs: durationMs,
    estimatedWakesAvoided,
    barrierViolated: result.barrierViolated,
    planReasons: plan.reasons,
  });

  const summaryLine =
    groupState === "completed"
      ? `Task Group ✓ · ${snapshot.counts.succeeded}/${snapshot.counts.total} succeeded · ${plan.strategy}`
      : groupState === "cancelled"
        ? "Task Group cancelled"
        : `Task Group failed · ${snapshot.counts.succeeded}/${snapshot.counts.total} succeeded`;
  let delivered = `${summaryLine}\n\n${gate.deliveredText}`;

  const isError = groupState === "failed" || groupState === "cancelled";
  const details: Record<string, unknown> = {
    protocol: snapshot.protocol,
    snapshot,
    gate: gate.mode,
    ...(result.groupError !== undefined ? { error: result.groupError } : {}),
    ...(result.barrierViolated !== undefined ? { barrierViolation: result.barrierViolated } : {}),
  };
  if (result.barrierViolated !== undefined) {
    delivered += `\n\nwarning: ${result.barrierViolated}`;
  }
  return { text: delivered, details, isError, snapshot, plan, gateMode: gate.mode };
}
