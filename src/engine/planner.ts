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

function poolFeatureReason(spec: TaskGroupSpec): string | undefined {
  if (spec.execution.concurrency !== "auto") {
    return "Pool follows task.maxConcurrency and cannot honor per-group execution.concurrency";
  }
  if (spec.tasks.some((task) => task.schema !== undefined)) {
    return "Pool cannot enforce per-task output schemas; use Fanout";
  }
  if (spec.tasks.some((task) => task.isolated === true)) {
    return "Pool cannot preserve per-task worktree isolation; use Fanout";
  }
  return undefined;
}

function poolUnavailableReason(
  spec: TaskGroupSpec,
  capabilities: BackendCapabilities,
  poolConfig: { enabled: "auto" | "off"; threshold: number },
  homogeneous: boolean,
): string {
  if (!capabilities.workpool) return "native Workpool API unavailable";
  if (poolConfig.enabled === "off") return "Pool disabled by config";
  if (!capabilities.taskGroupPool) {
    return capabilities.taskGroupPoolReason || "Task Group Pool result/wait contract unavailable";
  }
  if (spec.join.mode !== "all" || spec.failure.mode !== "collect") return "Pool requires join=all and failure=collect";
  if (!homogeneous) return "Pool requires homogeneous tasks (same agent and tool set)";
  const featureReason = poolFeatureReason(spec);
  if (featureReason !== undefined) return featureReason;
  return "task count " + spec.tasks.length + " is below pool threshold " + poolConfig.threshold;
}

export function planExecution(
  spec: TaskGroupSpec,
  capabilities: BackendCapabilities,
  poolConfig: { enabled: "auto" | "off"; threshold: number },
): PlanResult {
  const reasons: string[] = [];
  const homogeneous = isHomogeneous(spec);
  const joinAllCollect = spec.join.mode === "all" && spec.failure.mode === "collect";
  const featureReason = poolFeatureReason(spec);
  const countOk = spec.tasks.length >= poolConfig.threshold;
  const poolCandidate = joinAllCollect && homogeneous && countOk;
  const poolEligible =
    capabilities.workpool &&
    capabilities.taskGroupPool &&
    poolCandidate &&
    poolConfig.enabled !== "off" &&
    featureReason === undefined;

  reasons.push("tasks: " + spec.tasks.length);
  reasons.push("agents: " + spec.tasks.map((t) => t.agent).join(", "));
  reasons.push("join: " + spec.join.mode + (spec.join.mode === "quorum" ? " (" + spec.join.quorum + ")" : ""));
  reasons.push("failure: " + spec.failure.mode);
  reasons.push("homogeneous: " + (homogeneous ? "yes" : "no"));
  reasons.push(
    "native Workpool API: " +
      (capabilities.workpool ? "documented Eval surface; runtime preflight required" : "unavailable"),
  );
  reasons.push(
    "Task Group Pool: " +
      (capabilities.taskGroupPool ? "conditional candidate; Eval validates status/peek and ownership before dispatch" : "unavailable"),
  );

  let strategy: StrategyDecision;
  let fallbackReason: string | undefined;
  if (spec.execution.strategy === "fanout") {
    strategy = "fanout";
    reasons.push("strategy: fanout (explicit)");
  } else if (spec.execution.strategy === "pool") {
    if (poolEligible) {
      strategy = "pool";
      reasons.push("strategy: pool (explicit, eligible; runtime preflight before dispatch)");
    } else {
      strategy = "fanout";
      fallbackReason = poolUnavailableReason(spec, capabilities, poolConfig, homogeneous);
      reasons.push("strategy: fanout (downgraded from pool: " + fallbackReason + ")");
    }
  } else if (poolConfig.enabled === "off") {
    strategy = "fanout";
    reasons.push("strategy: fanout (pool disabled by config)");
  } else if (poolEligible) {
    strategy = "pool";
    reasons.push(
      "strategy: pool (homogeneous, count " + spec.tasks.length + " >= threshold " + poolConfig.threshold +
        ", join all, collect; runtime preflight before dispatch)",
    );
  } else {
    strategy = "fanout";
    if (poolCandidate) {
      fallbackReason = poolUnavailableReason(spec, capabilities, poolConfig, homogeneous);
      reasons.push("strategy: fanout (Pool candidate downgraded: " + fallbackReason + ")");
    } else {
      reasons.push("strategy: fanout (heterogeneous or below pool threshold or non-all join)");
    }
  }

  reasons.push("concurrency: " + (spec.execution.concurrency === "auto" ? "inherit (task.maxConcurrency)" : String(spec.execution.concurrency)));
  return { strategy, fallbackReason, reasons, concurrency: spec.execution.concurrency };
}
