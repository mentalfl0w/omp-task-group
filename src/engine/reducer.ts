/**
 * omp-task-group — single state reducer: events in, snapshot out.
 *
 * Runtime never keeps TUI/RPC-specific state; presenters derive everything
 * from the snapshot this reducer produces.
 */

import {
  PROTOCOL,
  type GroupCounts,
  type GroupEvent,
  type GroupState,
  type GroupMetrics,
  type TaskGroupSnapshot,
  type TaskSnapshot,
  type TaskState,
} from "../state/events";

function emptyCounts(total: number): GroupCounts {
  return { queued: total, running: 0, succeeded: 0, failed: 0, cancelled: 0, total };
}

function emptyMetrics(): GroupMetrics {
  return { rawChildChars: 0, deliveredChars: 0, estimatedWakesAvoided: 0 };
}

/** Create the initial snapshot for a freshly planned group. */
export function initialSnapshot(
  groupId: string,
  label: string | undefined,
  strategy: TaskGroupSnapshot["strategy"],
  join: TaskGroupSnapshot["join"],
  failure: TaskGroupSnapshot["failure"],
  tasks: Array<{ name: string; agent: string }>,
  fallbackReason?: string,
): TaskGroupSnapshot {
  const snapshot: TaskGroupSnapshot = {
    protocol: PROTOCOL,
    groupId,
    state: "running",
    backend: "eval",
    strategy,
    join,
    failure,
    counts: emptyCounts(tasks.length),
    tasks: tasks.map<TaskSnapshot>((t) => ({ name: t.name, agent: t.agent, state: "queued" })),
    startedAtMs: Date.now(),
    metrics: emptyMetrics(),
  };
  if (label !== undefined) snapshot.label = label;
  if (fallbackReason !== undefined) snapshot.fallbackReason = fallbackReason;
  return snapshot;
}

const SETTLED_STATES: readonly TaskState[] = ["succeeded", "failed", "cancelled"];

function isSettled(state: TaskState): boolean {
  return SETTLED_STATES.includes(state);
}

function countsFrom(tasks: TaskSnapshot[]): GroupCounts {
  const counts = emptyCounts(tasks.length);
  counts.queued = 0;
  for (const t of tasks) counts[t.state] += 1;
  return counts;
}

/** Derive group-level state from task states + join policy. */
function deriveGroupState(
  tasks: TaskSnapshot[],
  join: TaskGroupSnapshot["join"],
  failure: TaskGroupSnapshot["failure"],
  current: GroupState,
): GroupState {
  if (current === "completed" || current === "failed" || current === "cancelled") return current;
  const succeeded = tasks.filter((t) => t.state === "succeeded").length;
  const failed = tasks.filter((t) => t.state === "failed").length;
  const cancelled = tasks.filter((t) => t.state === "cancelled").length;
  const settled = succeeded + failed + cancelled;
  const quorum = join.mode === "quorum" ? (join.quorum ?? tasks.length) : null;

  if (join.mode === "any" && succeeded > 0) return "joining";
  if (quorum !== null && succeeded >= quorum) return "joining";
  if (failure.mode === "fail_fast" && failed > 0) return "joining";
  if (settled === tasks.length) return "joining";
  return "running";
}

export class SnapshotReducer {
  private snapshot: TaskGroupSnapshot;

  constructor(initial: TaskGroupSnapshot) {
    this.snapshot = initial;
  }

  get current(): TaskGroupSnapshot {
    return this.snapshot;
  }

  apply(event: GroupEvent): TaskGroupSnapshot {
    const s = this.snapshot;
    switch (event.type) {
      case "group_started": {
        s.groupId = event.groupId;
        if (event.label !== undefined) s.label = event.label;
        s.strategy = event.strategy;
        if (event.fallbackReason !== undefined) s.fallbackReason = event.fallbackReason;
        s.join = event.join;
        s.failure = event.failure;
        s.tasks = event.taskNames.map((t) => ({ name: t.name, agent: t.agent, state: "queued" }));
        s.startedAtMs = event.startedAtMs;
        s.state = "running";
        s.counts = emptyCounts(s.tasks.length);
        break;
      }
      case "task_state": {
        const task = s.tasks.find((t) => t.name === event.name);
        if (!task) break;
        task.state = event.state;
        if (event.handle !== undefined) task.handle = event.handle;
        if (event.durationMs !== undefined) task.durationMs = event.durationMs;
        if (event.resolvedModel !== undefined) task.resolvedModel = event.resolvedModel;
        if (event.error !== undefined) task.error = event.error;
        if (event.tokens !== undefined) task.tokens = event.tokens;
        s.counts = countsFrom(s.tasks);
        s.state = deriveGroupState(s.tasks, s.join, s.failure, s.state);
        break;
      }
      case "task_progress": {
        const task = s.tasks.find((t) => t.name === event.name);
        if (task && event.tokens !== undefined) task.tokens = event.tokens;
        break;
      }
      case "group_state": {
        s.state = event.state;
        if (event.durationMs !== undefined) s.durationMs = event.durationMs;
        break;
      }
      case "metrics": {
        if (event.rawChildChars !== undefined) s.metrics.rawChildChars = event.rawChildChars;
        if (event.deliveredChars !== undefined) s.metrics.deliveredChars = event.deliveredChars;
        if (event.estimatedWakesAvoided !== undefined) {
          s.metrics.estimatedWakesAvoided = event.estimatedWakesAvoided;
        }
        break;
      }
    }
    return s;
  }

  /** Finalize the group: recompute counts and stamps duration. */
  finalize(finalState: GroupState, durationMs: number): TaskGroupSnapshot {
    this.snapshot.state = finalState;
    this.snapshot.durationMs = durationMs;
    this.snapshot.counts = countsFrom(this.snapshot.tasks);
    return this.snapshot;
  }
}
