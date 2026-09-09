/**
 * omp-task-group — telemetry.
 *
 * Per-group entries are persisted into the session via pi.appendEntry
 * (package-qualified customType) and reconstructed on session_start from
 * ctx.sessionManager.getBranch(). An in-memory aggregate serves
 * /task-group stats in the live session.
 *
 * Definitions:
 *   Wake Amplification       = logical parent deliveries / child completions
 *   Estimated Wakes Avoided  = max(0, settled children - logical deliveries)
 * (Estimated: not a claim about provider inference counts.)
 */

import { isRecord } from "../guards";
import type { TelemetryGroupEntry } from "../engine/runner";

export const TELEMETRY_ENTRY_TYPE = "omp-task-group.telemetry.v1";

export interface TelemetryAggregate {
  groups: number;
  childExecutions: number;
  logicalDeliveries: number;
  estimatedWakesAvoided: number;
  rawChildChars: number;
  deliveredChars: number;
  fanoutSelections: number;
  poolSelections: number;
  poolFallbacks: number;
  joinAll: number;
  joinAny: number;
  joinQuorum: number;
  successes: number;
  failures: number;
  cancellations: number;
  groupDurations: number[];
  missedGroupCandidates: number;
  barrierViolations: number;
}

export function emptyAggregate(): TelemetryAggregate {
  return {
    groups: 0,
    childExecutions: 0,
    logicalDeliveries: 0,
    estimatedWakesAvoided: 0,
    rawChildChars: 0,
    deliveredChars: 0,
    fanoutSelections: 0,
    poolSelections: 0,
    poolFallbacks: 0,
    joinAll: 0,
    joinAny: 0,
    joinQuorum: 0,
    successes: 0,
    failures: 0,
    cancellations: 0,
    groupDurations: [],
    missedGroupCandidates: 0,
    barrierViolations: 0,
  };
}

export class Telemetry {
  readonly aggregate: TelemetryAggregate = emptyAggregate();
  /** Per-group entries this session (latest last). */
  readonly entries: TelemetryGroupEntry[] = [];

  constructor(private readonly appendEntry: ((customType: string, data?: unknown) => void) | undefined) {}

  recordGroup(entry: TelemetryGroupEntry): void {
    this.entries.push(entry);
    const a = this.aggregate;
    a.groups += 1;
    a.childExecutions += entry.taskCount;
    a.logicalDeliveries += 1;
    a.estimatedWakesAvoided += entry.estimatedWakesAvoided;
    a.rawChildChars += entry.rawChildChars;
    a.deliveredChars += entry.deliveredChars;
    if (entry.strategy === "fanout") a.fanoutSelections += 1;
    else a.poolSelections += 1;
    if (entry.fallbackReason !== undefined) a.poolFallbacks += 1;
    if (entry.join.mode === "all") a.joinAll += 1;
    else if (entry.join.mode === "any") a.joinAny += 1;
    else a.joinQuorum += 1;
    a.successes += entry.succeeded;
    a.failures += entry.failed;
    a.cancellations += entry.cancelled;
    a.groupDurations.push(entry.groupDurationMs);
    if (entry.barrierViolated !== undefined) a.barrierViolations += 1;
    try {
      this.appendEntry?.(TELEMETRY_ENTRY_TYPE, entry);
    } catch {
      // Persistence is best-effort; in-memory aggregate still works.
    }
  }

  recordMissedGroupCandidate(): void {
    this.aggregate.missedGroupCandidates += 1;
    try {
      this.appendEntry?.(TELEMETRY_ENTRY_TYPE, { kind: "missed_group_candidate" });
    } catch {
      // best-effort
    }
  }

  get wakeAmplification(): number {
    return this.aggregate.childExecutions === 0 ? 0 : this.aggregate.logicalDeliveries / this.aggregate.childExecutions;
  }

  get outputReduction(): number {
    if (this.aggregate.rawChildChars === 0) return 0;
    return 1 - this.aggregate.deliveredChars / this.aggregate.rawChildChars;
  }

  /** Merge persisted entries from a session branch (rehydrate on start). */
  rehydrate(branch: unknown[]): void {
    for (const entry of branch) {
      if (!isRecord(entry)) continue;
      if (entry.type !== "custom" || entry.customType !== TELEMETRY_ENTRY_TYPE) continue;
      const data = entry.data;
      if (!isRecord(data)) continue;
      if (isRecord(data) && data.kind === "missed_group_candidate") {
        this.aggregate.missedGroupCandidates += 1;
        continue;
      }
      const group = data as unknown as Partial<TelemetryGroupEntry>;
      if (typeof group.groupId !== "string" || typeof group.taskCount !== "number") continue;
      this.entries.push(group as TelemetryGroupEntry);
      const a = this.aggregate;
      a.groups += 1;
      a.childExecutions += group.taskCount ?? 0;
      a.logicalDeliveries += 1;
      a.estimatedWakesAvoided += group.estimatedWakesAvoided ?? 0;
      a.rawChildChars += group.rawChildChars ?? 0;
      a.deliveredChars += group.deliveredChars ?? 0;
      if (group.strategy === "fanout") a.fanoutSelections += 1;
      else if (group.strategy === "pool") a.poolSelections += 1;
      if (group.fallbackReason !== undefined) a.poolFallbacks += 1;
      if (group.join?.mode === "any") a.joinAny += 1;
      else if (group.join?.mode === "quorum") a.joinQuorum += 1;
      else a.joinAll += 1;
      a.successes += group.succeeded ?? 0;
      a.failures += group.failed ?? 0;
      a.cancellations += group.cancelled ?? 0;
      a.groupDurations.push(group.groupDurationMs ?? 0);
    }
  }
}
