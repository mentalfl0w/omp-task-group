/**
 * omp-task-group — extension entry point.
 *
 * Task Group deliberately does not register `eval`. A standard JavaScript eval
 * cell containing the strict `ompTaskGroup(<JSON>)` envelope is rewritten at
 * `tool_call`, then its native `display()` payload is finalized at
 * `tool_result`. Ordinary eval calls never enter this path.
 *
 * Public API only: docs/extensions.md and docs/tools/eval.md. No OMP private
 * imports, no global mutable state, and protocol failures are fail-closed.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolBlockResult,
  ToolCallEvent,
  ToolResultEvent,
  ToolResultPatch,
} from "./types";
import { validateSpec, type TaskGroupSpec } from "./schema/task-group";
import { loadConfig, ConfigLoadError } from "./config-load";
import { defaultConfig, type TaskGroupConfig } from "./config";
import { scanAutoBackgroundConfig } from "./barriers";
import type { BackendCapabilities, TaskGroupBackend } from "./backend/interface";
import { decodeDisplayGroupResult } from "./backend/display-result";
import { compileFanoutProgram, compilePoolProgram } from "./compiler/program";
import { parseTaskGroupEnvelope } from "./envelope";
import { newGroupId, runTaskGroup } from "./engine/runner";
import { planExecution, type PlanResult } from "./engine/planner";
import { Telemetry } from "./telemetry/metrics";
import { injectPolicy } from "./dispatcher/policy";
import { MissedGroupDetector } from "./dispatcher/missed-group";
import { registerTaskGroupCommand } from "./commands";
import { probeCapabilities, type CapabilityReport } from "./capabilities";
import { isRecord } from "./guards";

interface PendingEnvelope {
  spec: TaskGroupSpec;
  config: TaskGroupConfig;
  groupId: string;
  plan: PlanResult;
  capabilities: BackendCapabilities;
  rewrittenInput: Record<string, unknown>;
  collisionReason?: string;
}


function nativeEvalCapabilities(config: TaskGroupConfig): BackendCapabilities {
  return {
    fanout: true,
    workpool: true,
    summarize: config.summarize.enabled,
    structured: true,
    joinAll: true,
    joinAny: true,
    joinQuorum: true,
    rpcUi: false,
    notes: [
      "compiled through the standard native eval tool",
      "final result is decoded from native details.jsonOutputs",
      "no Task Group live marker stream",
    ],
  };
}

function block(reason: string): ToolBlockResult {
  return { block: true, reason };
}

function resultError(message: string): ToolResultPatch {
  return {
    content: [{ type: "text", text: `Task Group failed: ${message}` }],
    details: { protocol: "omp-task-group/v1", error: message },
    isError: true,
  };
}

function normalizeSpec(raw: unknown, config: TaskGroupConfig): TaskGroupSpec {
  const spec = validateSpec(raw);
  if (!isRecord(raw) || raw.join === undefined) spec.join = { mode: config.join.default };
  if (!isRecord(raw) || raw.failure === undefined) spec.failure = { mode: config.failure.default };
  return spec;
}

function isExpectedInput(input: unknown, pending: PendingEnvelope): boolean {
  return (
    isRecord(input) &&
    input.language === "js" &&
    input.timeout === 0 &&
    input.code === pending.rewrittenInput.code
  );
}

function backgroundedReason(details: unknown): string | undefined {
  if (!isRecord(details) || !isRecord(details.async)) return undefined;
  const jobId = typeof details.async.jobId === "string" ? ` (${details.async.jobId})` : "";
  return `native eval was auto-backgrounded${jobId}; Task Group requires one foreground eval result`;
}

/**
 * Extension factory. State is scoped to this registration so child runtimes
 * re-handshake naturally and unrelated OMP sessions never share call state.
 */
export default function taskGroupExtension(pi: ExtensionAPI): void {
  let fallbackConfig: TaskGroupConfig = defaultConfig();
  try {
    fallbackConfig = loadConfig(process.cwd());
  } catch (error) {
    pi.logger?.warn(`omp-task-group config load failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const telemetry = new Telemetry((customType, data) => pi.appendEntry(customType, data));
  const pendingCalls = new Map<string, PendingEnvelope>();
  let lastPlan: PlanResult | undefined;
  let capabilityReport: CapabilityReport | undefined;
  const detector = new MissedGroupDetector(fallbackConfig, () => telemetry.recordMissedGroupCandidate());

  // ── Smart Dispatcher: policy injection (suggest default) ──────────
  pi.on("before_agent_start", (event) => injectPolicy(event, fallbackConfig));

  // ── Missed-group telemetry (post-hoc only) ────────────────────────
  pi.on("turn_start", () => detector.onTurnStart());
  pi.on("turn_end", () => detector.onTurnEnd());
  pi.on("tool_execution_start", (event) => detector.onToolExecutionStart(event.toolName, event.toolCallId, event.intent));
  pi.on("tool_execution_end", (event) => detector.onToolExecutionEnd(event.toolCallId));

  // ── Telemetry rehydrate + capability probe per session ────────────
  const onSessionOpen = (ctx: ExtensionContext): void => {
    pendingCalls.clear();
    telemetry.rehydrate(ctx.sessionManager.getBranch());
    capabilityReport = probeCapabilities(ctx, fallbackConfig);
  };
  pi.on("session_start", (_event, ctx) => onSessionOpen(ctx));
  pi.on("session_switch", (_event, ctx) => onSessionOpen(ctx));
  pi.on("session_branch", (_event, ctx) => onSessionOpen(ctx));
  pi.on("session_tree", (_event, ctx) => onSessionOpen(ctx));
  pi.on("session_shutdown", () => pendingCalls.clear());

  // ── Enforce-mode guard: block an obviously-batched native task call ─
  pi.on("tool_call", (event) => {
    if (fallbackConfig.dispatcher.mode !== "enforce") return undefined;
    if (event.toolName !== "task") return undefined;
    const tasks = event.input.tasks;
    if (Array.isArray(tasks) && tasks.length >= 2) {
      return block(
        "This workload should use Task Group: call eval with language \"js\", timeout 0, and code ompTaskGroup(<strict JSON>). 2+ independent jobs belong in one atomic fan-out with a single joined result. If the jobs are dependent stages, use swarm instead.",
      );
    }
    return undefined;
  });

  // ── Standard-eval envelope recognition and compilation ────────────
  pi.on("tool_call", (event: ToolCallEvent, ctx: ExtensionContext) => {
    if (event.toolName !== "eval") return undefined;

    const envelope = parseTaskGroupEnvelope(event.input.code);
    if (envelope.kind === "non-envelope") return undefined;
    if (envelope.kind === "malformed") {
      return block(`Task Group envelope invalid: ${envelope.error.message}`);
    }
    if (event.input.language !== "js") {
      return block('Task Group envelope requires standard eval with language "js"');
    }

    let config: TaskGroupConfig;
    try {
      config = loadConfig(ctx.cwd);
    } catch (error) {
      const message = error instanceof ConfigLoadError ? error.message : String(error);
      return block(`omp-task-group configuration error: ${message}`);
    }
    if (!config.enabled) {
      return block("omp-task-group is disabled by config (enabled=false); use the native async task tool instead");
    }

    const barrier = scanAutoBackgroundConfig(ctx.cwd);
    if (!barrier.safe) {
      return block(
        [
          "Task Group requires foreground native eval: " + barrier.reason,
          "",
          "Fix: set eval.autoBackground.enabled=false. Task Group has no degraded auto-background mode because that would break its one-result guarantee.",
        ].join("\n"),
      );
    }

    let spec: TaskGroupSpec;
    try {
      spec = normalizeSpec(envelope.spec, config);
    } catch (error) {
      return block(`Task Group spec invalid: ${error instanceof Error ? error.message : String(error)}`);
    }

    const groupId = newGroupId();
    const capabilities = nativeEvalCapabilities(config);
    const plan = planExecution(spec, capabilities, {
      enabled: config.execution.pool.enabled,
      threshold: config.execution.pool.threshold,
    });
    const compileOptions = {
      groupId,
      ...(config.summarize.enabled ? { summarize: { model: config.summarize.model } } : {}),
    };
    const code =
      plan.strategy === "pool"
        ? compilePoolProgram(spec, compileOptions)
        : compileFanoutProgram(spec, compileOptions);
    const rewrittenInput: Record<string, unknown> = {
      language: "js",
      code,
      title: typeof event.input.title === "string" ? event.input.title : `task group: ${spec.label ?? groupId}`,
      timeout: 0,
      ...(event.input.reset === true ? { reset: true } : {}),
    };

    pendingCalls.set(event.toolCallId, {
      spec,
      config,
      groupId,
      plan,
      capabilities,
      rewrittenInput,
    });
    lastPlan = plan;
    return { input: rewrittenInput };
  });

  // A later input-rewriting hook could replace our compiled cell. The public
  // execution-start event sees the effective validated input, so abort before
  // it runs and refuse to interpret the eventual unrelated result.
  pi.on("tool_execution_start", (event, ctx) => {
    if (event.toolName !== "eval") return;
    const pending = pendingCalls.get(event.toolCallId);
    if (pending === undefined || isExpectedInput(event.args, pending)) return;
    pending.collisionReason =
      "another extension replaced the Task Group compiled eval input after envelope recognition";
    ctx.abort();
  });

  // ── Final result decoding + single joined delivery ─────────────────
  pi.on("tool_result", async (event: ToolResultEvent): Promise<ToolResultPatch | undefined> => {
    if (event.toolName !== "eval") return undefined;
    const pending = pendingCalls.get(event.toolCallId);
    if (pending === undefined) return undefined;
    pendingCalls.delete(event.toolCallId);

    if (pending.collisionReason !== undefined) {
      return resultError(`${pending.collisionReason}; the eval run was aborted before Task Group execution`);
    }
    if (!isExpectedInput(event.input, pending)) {
      return resultError("another extension changed the Task Group effective eval input; refusing to interpret its result");
    }

    const backgrounded = backgroundedReason(event.details);
    if (backgrounded !== undefined) return resultError(backgrounded);
    if (event.isError) return undefined;

    try {
      const result = decodeDisplayGroupResult(event.details, pending.spec, pending.groupId);
      const backend: TaskGroupBackend = {
        capabilities: () => pending.capabilities,
        runGroup: async () => result,
      };
      const outcome = await runTaskGroup({
        spec: pending.spec,
        config: pending.config,
        backend,
        signal: undefined,
        onUpdate: undefined,
        telemetry,
        groupId: pending.groupId,
        plan: pending.plan,
      });
      lastPlan = outcome.plan;
      return {
        content: [{ type: "text", text: outcome.text }],
        details: outcome.details,
        isError: outcome.isError,
      };
    } catch (error) {
      return resultError(
        `native eval completed without a valid Task Group display result: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  // ── /task-group command ────────────────────────────────────────────
  registerTaskGroupCommand(pi, {
    getConfig: () => {
      try {
        return loadConfig(process.cwd());
      } catch {
        return fallbackConfig;
      }
    },
    getTelemetry: () => telemetry,
    getLastPlan: () => lastPlan,
    getCapabilities: (ctx) => capabilityReport ?? probeCapabilities(ctx, fallbackConfig),
  });
}

