/**
 * omp-task-group — /task-group command.
 *
 *   /task-group            overview + capabilities
 *   /task-group stats      cumulative telemetry for this session
 *   /task-group explain    why the last group chose its strategy
 *   /task-group config     effective configuration
 */

import type { ExtensionAPI, ExtensionCommandContext } from "./types";
import type { TaskGroupConfig } from "./config";
import { probeCapabilities, type CapabilityReport } from "./capabilities";
import type { Telemetry } from "./telemetry/metrics";
import type { PlanResult } from "./engine/planner";

export interface CommandDeps {
  getConfig: () => TaskGroupConfig;
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
    description: "Task Group: stats / explain / config",
    handler: async (args, ctx) => {
      const sub = args.trim().split(/\s+/)[0] ?? "";
      const config = deps.getConfig();
      let text: string;
      if (sub === "stats") {
        text = renderStats(deps.getTelemetry());
      } else if (sub === "explain") {
        text = renderExplain(deps.getLastPlan());
      } else if (sub === "config") {
        text = `Task Group configuration\n\n${JSON.stringify(config, null, 2)}`;
      } else {
        const caps = deps.getCapabilities(ctx);
        const capLines = caps.rows.map((r) => `${r.ok ? "✓" : "✗"} ${r.name}${r.note ? `  — ${r.note}` : ""}`);
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
          "Subcommands: stats · explain · config",
        ].join("\n");
      }
      ctx.ui.notify(text, "info");
    },
  });
}
