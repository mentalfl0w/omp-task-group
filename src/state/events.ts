/**
 * omp-task-group — runtime event + snapshot protocol (omp-task-group/v1).
 *
 * The runtime emits domain events; a single reducer folds them into one
 * TaskGroupSnapshot; every presenter (TUI / RPC-UI / text / RPC data plane)
 * consumes only that snapshot. Presenters never read child-agent state
 * directly.
 */

export const PROTOCOL = "omp-task-group/v1";

export type TaskState = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type GroupState = "running" | "joining" | "completed" | "failed" | "cancelled";
export type StrategyName = "fanout" | "pool";

export interface TaskSnapshot {
  name: string;
  agent: string;
  state: TaskState;
  /** agent:// handle for the full transcript (preserveHandles). */
  handle?: string;
  durationMs?: number;
  /** Estimated tokens (budget delta); null when unavailable. */
  tokens?: number | null;
  resolvedModel?: string;
  error?: string;
}

export interface GroupCounts {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  total: number;
}

export interface GroupMetrics {
  rawChildChars: number;
  deliveredChars: number;
  estimatedWakesAvoided: number;
}

export interface TaskGroupSnapshot {
  protocol: typeof PROTOCOL;
  groupId: string;
  label?: string;
  state: GroupState;
  backend: "eval";
  strategy: StrategyName;
  /** Set when the planner downgraded (e.g. pool → fanout); explains why. */
  fallbackReason?: string;
  join: { mode: "all" | "any" | "quorum"; quorum?: number };
  failure: { mode: "collect" | "fail_fast" };
  counts: GroupCounts;
  tasks: TaskSnapshot[];
  startedAtMs: number;
  durationMs?: number;
  metrics: GroupMetrics;
}

// ── Domain events (reducer input) ────────────────────────────────────

export interface GroupStartedEvent {
  type: "group_started";
  groupId: string;
  label?: string;
  strategy: StrategyName;
  fallbackReason?: string;
  join: TaskGroupSnapshot["join"];
  failure: TaskGroupSnapshot["failure"];
  taskNames: Array<{ name: string; agent: string }>;
  startedAtMs: number;
}

export interface TaskStateChangedEvent {
  type: "task_state";
  name: string;
  state: Exclude<TaskState, "queued">;
  handle?: string;
  durationMs?: number;
  resolvedModel?: string;
  error?: string;
  tokens?: number | null;
}

export interface TaskProgressEvent {
  type: "task_progress";
  name: string;
  tokens?: number | null;
}

export interface GroupStateChangedEvent {
  type: "group_state";
  state: GroupState;
  durationMs?: number;
}

export interface MetricsEvent {
  type: "metrics";
  rawChildChars?: number;
  deliveredChars?: number;
  estimatedWakesAvoided?: number;
}

export type GroupEvent =
  | GroupStartedEvent
  | TaskStateChangedEvent
  | TaskProgressEvent
  | GroupStateChangedEvent
  | MetricsEvent;
