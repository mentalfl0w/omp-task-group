/**
 * omp-task-group — /task-group command.
 *
 *   /task-group            overview + capabilities
 *   /task-group stats      cumulative telemetry for this session
 *   /task-group explain    why the last group chose its strategy
 *   /task-group config     effective configuration
 *   /task-group background  two-phase Workpool background + foreground scan
 */

import type { ExtensionAPI, ExtensionCommandContext } from "./types";
import type { TaskGroupConfig } from "./config";
import { type CapabilityReport } from "./capabilities";
import { formatBarrierDiagnosis, scanAutoBackgroundConfig } from "./barriers";
import type { Telemetry } from "./telemetry/metrics";
import type { PlanResult } from "./engine/planner";

export interface CommandDeps {
  getConfig: (ctx: ExtensionCommandContext) => TaskGroupConfig;
  getTelemetry: () => Telemetry;
  getLastPlan: () => PlanResult | undefined;
  getCapabilities: (ctx: ExtensionCommandContext) => CapabilityReport;
}

function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtChars(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function renderStats(t: Telemetry): string {
  const a = t.aggregate;
  const durations = a.groupDurations;
  const avg = durations.length > 0 ? durations.reduce((x, y) => x + y, 0) / durations.length : 0;
  const lines = [
    "Task Group Statistics",
    "",
    `Groups                     ${fmtInt(a.groups)}`,
    `Child executions           ${fmtInt(a.childExecutions)}`,
    "",
    `Logical deliveries         ${fmtInt(a.logicalDeliveries)}`,
    `Estimated wakes avoided    ${fmtInt(a.estimatedWakesAvoided)}`,
    `Wake amplification         ${t.wakeAmplification.toFixed(3)}`,
    "",
    `Raw child output           ${fmtChars(a.rawChildChars)} chars`,
    `Delivered to parent        ${fmtChars(a.deliveredChars)} chars`,
    `Output reduction           ${(t.outputReduction * 100).toFixed(1)}%`,
    "Background native notices and collect/read/consume calls are excluded from these estimates.",
    "",
    `Fanout                     ${fmtInt(a.fanoutSelections)}`,
    `Workpool                   ${fmtInt(a.poolSelections)}`,
    `Pool fallbacks             ${fmtInt(a.poolFallbacks)}`,
    "",
    `join all / any / quorum    ${a.joinAll} / ${a.joinAny} / ${a.joinQuorum}`,
    `successes / failures       ${a.successes} / ${a.failures}`,
    `cancellations              ${a.cancellations}`,
    `avg group duration         ${(avg / 1000).toFixed(1)}s`,
    "",
    `Missed group candidates    ${fmtInt(a.missedGroupCandidates)}`,
    `Barrier violations         ${a.barrierViolations}`,
  ];
  return lines.join("\n");
}

function renderExplain(plan: PlanResult | undefined): string {
  if (plan === undefined) {
    return "No Task Group has run in this session yet.";
  }
  return ["Last Task Group", "", ...plan.reasons.map((r) => `- ${r}`)].join("\n");
}

export function registerTaskGroupCommand(pi: ExtensionAPI, deps: CommandDeps): void {
  pi.registerCommand("task-group", {
    description: "Task Group: stats / explain / config / background",
    handler: async (args, ctx) => {
      const sub = args.trim().split(/\s+/)[0] ?? "";
      const config = deps.getConfig(ctx);
      let text: string;
      if (sub === "stats") {
        text = renderStats(deps.getTelemetry());
      } else if (sub === "explain") {
        text = renderExplain(deps.getLastPlan());
      } else if (sub === "config") {
        const retention = config.background.retentionMinutes;
        text = [
          "Task Group configuration",
          "",
          JSON.stringify(config, null, 2),
          "",
          "Background execution: explicit two-phase Workpool opt-in (background=\"require\" or execution.mode=\"background\"). Admission requires homogeneous join=all + failure=collect tasks and a Workpool plan. The dispatch cell returns after verified push ids; an explicit ompTaskGroupCollect cell follows OMP's native async-result notice; the gated result is read with task_group_result. It does not depend on eval.autoBackground.",
          `Result retention: background.retentionMinutes=${retention} (observed-result window; range 1-1440, default 30). The pending deadline stays at two hours and this key never enables background execution.`,
        ].join("\n");
      } else if (sub === "background") {
        const retention = config.background.retentionMinutes;
        text = [
          "Task Group background (two-phase native Workpool):",
          "- opt in with background=\"require\" or execution.mode=\"background\".",
          "- admission: homogeneous join=all + failure=collect, no per-task schema/isolation, execution.concurrency=auto, output.mode compact|structured, pool enabled; the numeric pool threshold is not applied.",
          "- dispatch: creates workpool(name=groupId), pushes every task, retains {pool, itemIds} in the eval kernel, and returns the verified ids. No wait(), no background promise, no plugin notification.",
          "- completion signal: OMP's own async-result notice. Its preview can contain ungated aggregate child text and is not the Task Group result.",
          "- collect: ompTaskGroupCollect({\"groupId\":…,\"resultId\":…}) reads only status()/peek(). It reports pending while the pool drains, never waits, never consumes another job, and fails closed on an incompatible or missing kernel handle.",
          "- result: one atomic 0600 file in a 0700 private directory, SHA-256 verified, read and consumed with task_group_result.",
          "- cancel: write proc://<groupId>/kill, then collect. No result is fabricated if the pool service is already gone; OMP may send no async-result after cancellation.",
          "",
          "Foreground compatibility (eval.autoBackground scan):",
          formatBarrierDiagnosis(scanAutoBackgroundConfig(ctx.cwd, { mode: ctx.mode })),
          "",
          `Task Group result retention for this cwd: ${retention} minute(s) (background.retentionMinutes; range 1-1440, default 30).`,
          "It bounds only an observed, unconsumed result file and never modifies the upstream eval.autoBackground settings. The pending deadline remains two hours.",
        ].join("\n");
      } else {
        const caps = deps.getCapabilities(ctx);
        const capLines = caps.rows.map((r) => {
          const marker = r.availability === "conditional" ? "~" : r.ok ? "✓" : "✗";
          return `${marker} ${r.name}${r.note ? `  — ${r.note}` : ""}`;
        });
        text = [
          "omp-task-group — atomic multi-agent coordination",
          "",
          "Not a workflow engine: no DAG, no depends_on, no pipeline, no resume.",
          "2+ independent jobs + one joined result → standard eval with an ompTaskGroup(<strict JSON>) envelope.",
          "Single delegation → async task. Dependencies/pipelines → swarm.",
          "",
          "Capabilities:",
          ...capLines,
          "",
          "Subcommands: stats · explain · config · background",
        ].join("\n");
      }
      ctx.ui.notify(text, "info");
    },
  });
}
