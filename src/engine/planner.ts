/**
 * omp-task-group — planner: execution strategy selection.
 *
 * Pure function over (spec, config, capabilities). Deterministic, explained,
 * and never a black box: every decision records its reasons for
 * `/task-group explain`.
 */

import type { BackendCapabilities } from "../backend/interface";
import type { TaskGroupSpec } from "../schema/task-group";

export type StrategyDecision = "fanout" | "pool";

export interface PlanResult {
  strategy: StrategyDecision;
  /** Set when an explicitly requested strategy was downgraded. */
  fallbackReason?: string;
  /** Human-readable decision trace for /task-group explain. */
  reasons: string[];
  concurrency: "auto" | number;
}

function isHomogeneous(spec: TaskGroupSpec): boolean {
  const first = spec.tasks[0];
  if (!first) return false;
  return spec.tasks.every(
    (t) =>
      t.agent === first.agent &&
      (t.isolated ?? false) === (first.isolated ?? false) &&
      (t.schema !== undefined) === (first.schema !== undefined) &&
      (t.tools?.join(",") ?? "") === (first.tools?.join(",") ?? ""),
  );
}

export function planExecution(
  spec: TaskGroupSpec,
  capabilities: BackendCapabilities,
  poolConfig: { enabled: "auto" | "off"; threshold: number },
): PlanResult {
  const reasons: string[] = [];
  const homogeneous = isHomogeneous(spec);
  const joinAllCollect = spec.join.mode === "all" && spec.failure.mode === "collect";

  const poolEligible =
    capabilities.workpool &&
    joinAllCollect &&
    homogeneous &&
    spec.tasks.length >= poolConfig.threshold;

  reasons.push(`tasks: ${spec.tasks.length}`);
  reasons.push(`agents: ${spec.tasks.map((t) => t.agent).join(", ")}`);
  reasons.push(`join: ${spec.join.mode}${spec.join.mode === "quorum" ? ` (${spec.join.quorum})` : ""}`);
  reasons.push(`failure: ${spec.failure.mode}`);
  reasons.push(`homogeneous: ${homogeneous ? "yes" : "no"}`);
  reasons.push(`pool capability: ${capabilities.workpool ? "available" : "unavailable"}`);

  let strategy: StrategyDecision;
  let fallbackReason: string | undefined;

  if (spec.execution.strategy === "fanout") {
    strategy = "fanout";
    reasons.push("strategy: fanout (explicit)");
  } else if (spec.execution.strategy === "pool") {
    if (poolEligible && poolConfig.enabled !== "off") {
      strategy = "pool";
      reasons.push("strategy: pool (explicit, eligible)");
    } else {
      strategy = "fanout";
      fallbackReason = !capabilities.workpool
        ? "workpool capability unavailable"
        : !joinAllCollect
          ? "pool requires join=all + failure=collect"
          : !homogeneous
            ? "pool requires homogeneous tasks (same agent, isolation, tools, schema)"
            : `task count ${spec.tasks.length} < pool threshold ${poolConfig.threshold}`;
      reasons.push(`strategy: fanout (downgraded from pool: ${fallbackReason})`);
    }
  } else {
    if (poolConfig.enabled === "off") {
      strategy = "fanout";
      reasons.push("strategy: fanout (pool disabled by config)");
    } else {
      const countOk = spec.tasks.length >= poolConfig.threshold;
      if (joinAllCollect && homogeneous && countOk && capabilities.workpool) {
        strategy = "pool";
        reasons.push(
          `strategy: pool (homogeneous, count ${spec.tasks.length} >= threshold ${poolConfig.threshold}, join all, collect)`,
        );
      } else {
        strategy = "fanout";
        reasons.push("strategy: fanout (heterogeneous or below pool threshold or non-all join)");
        if (joinAllCollect && homogeneous && countOk && !capabilities.workpool) {
          fallbackReason = "workpool capability unavailable";
          reasons.push(`strategy: fanout (downgraded from pool: ${fallbackReason})`);
        }
      }
    }
  }

  const concurrency = spec.execution.concurrency;
  reasons.push(`concurrency: ${concurrency === "auto" ? "inherit (task.maxConcurrency)" : String(concurrency)}`);
  if (concurrency !== "auto" && strategy === "pool") {
    reasons.push("note: explicit concurrency is ignored by the workpool (OMP manages its worker bound)");
  }

  return { strategy, fallbackReason, reasons, concurrency };
}
