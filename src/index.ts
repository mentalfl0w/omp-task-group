/**
 * omp-task-group — extension entry point.
 *
 * Task Group deliberately does not register `eval`. A standard JavaScript eval
 * cell containing the strict `ompTaskGroup(<JSON>)` envelope is rewritten at
 * `tool_call`; the compiled program returns its result through OMP eval JSON
 * views, which the `tool_result` hook decodes. Ordinary eval calls are untouched.
 *
 * Public API only: docs/extensions.md and docs/tools/eval.md. No OMP private
 * imports, no global mutable state, and protocol failures are fail-closed.
 */

import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolBlockResult,
  ToolCallEvent,
  ToolResultEvent,
  ToolResultPatch,
} from "./types";
import { randomBytes } from "node:crypto";
import {
  isBackgroundRequested,
  validateSpec,
  type TaskGroupSpec,
} from "./schema/task-group";
import { loadConfig, ConfigLoadError } from "./config-load";
import { defaultConfig, type TaskGroupConfig } from "./config";
import { formatBarrierDiagnosis, scanAutoBackgroundConfig } from "./barriers";
import type {
  BackendCapabilities,
  GroupRunResult,
  TaskGroupBackend,
} from "./backend/interface";
import {
  decodeEvalGroupResult,
  decodeEvalPayload,
  decodePoolBackgroundCollect,
  decodePoolBackgroundDispatch,
  EvalResultError,
  type PoolBackgroundCollectReceipt,
  type PoolBackgroundDispatchReceipt,
} from "./backend/eval-result";
import {
  compileFanoutProgram,
  compilePoolBackgroundCollectProgram,
  compilePoolBackgroundDispatchProgram,
  compilePoolProgram,
  POOL_BACKGROUND_COLLECT_TRANSPORT,
} from "./compiler/program";
import { parseTaskGroupCollectEnvelope, parseTaskGroupEnvelope } from "./envelope";
import { newGroupId, runTaskGroup, type RunOutcome } from "./engine/runner";
import { planExecution, type PlanResult } from "./engine/planner";
import { Telemetry } from "./telemetry/metrics";
import { injectPolicy } from "./dispatcher/policy";
import { MissedGroupDetector } from "./dispatcher/missed-group";
import { registerTaskGroupCommand } from "./commands";
import { TASK_GROUP_POOL_PROC_CANCEL_CAPABILITY, probeCapabilities } from "./capabilities";
import { isRecord } from "./guards";
import {
  BackgroundResultIntegrityError,
  BackgroundResultPendingError,
} from "./background/result-file";
import {
  BackgroundResultStateError,
  BackgroundResultStore,
  sweepStaleBackgroundResultDirs,
  type BackgroundResultMaterialized,
  type BackgroundResultRecord,
} from "./background/store";

const BACKGROUND_DETAILS_PROTOCOL = "omp-task-group/background-v1";

interface FinalizeTarget {
  spec: TaskGroupSpec;
  config: TaskGroupConfig;
  groupId: string;
  plan: PlanResult;
  capabilities: BackendCapabilities;
}

interface PendingGroupCall extends FinalizeTarget {
  kind: "group";
  rewrittenInput: Record<string, unknown>;
  collisionReason?: string;
  /** Present only for an explicit two-phase background opt-in. */
  background?: BackgroundResultRecord;
}

interface PendingCollectCall {
  kind: "collect";
  groupId: string;
  resultId: string;
  storeCapability: string;
  rewrittenInput: Record<string, unknown>;
  collisionReason?: string;
}

type PendingCall = PendingGroupCall | PendingCollectCall;


function nativeEvalCapabilities(config: TaskGroupConfig, pi: ExtensionAPI): BackendCapabilities {
  let taskGroupPoolReason: string | undefined;
  try {
    const tools = pi.getAllTools?.();
    if (tools === undefined) {
      taskGroupPoolReason =
        `public Eval ToolInfo inventory is unavailable; cannot verify ${TASK_GROUP_POOL_PROC_CANCEL_CAPABILITY}, so using Fanout`;
    } else {
      const evalTools = tools.filter((tool) => tool.name === "eval");
      const evalWrappers = evalTools.filter((tool) => tool.sourceInfo?.source !== "builtin");
      if (evalTools.length === 0) {
        taskGroupPoolReason =
          `getAllTools() did not expose an Eval ToolInfo; cannot verify ${TASK_GROUP_POOL_PROC_CANCEL_CAPABILITY}, so using Fanout`;
      } else {
        const unmarked = evalWrappers.filter(
          (tool) => !tool.description?.split(/\s+/).includes(TASK_GROUP_POOL_PROC_CANCEL_CAPABILITY),
        );
        if (unmarked.length > 0) {
          taskGroupPoolReason =
            `${unmarked.length} Eval wrapper(s) do not declare ${TASK_GROUP_POOL_PROC_CANCEL_CAPABILITY}; Pool's proc cancellation policy is unknown, so using Fanout`;
        }
      }
    }
  } catch {
    taskGroupPoolReason =
      `could not inspect public Eval ToolInfo; cannot verify ${TASK_GROUP_POOL_PROC_CANCEL_CAPABILITY}, so using Fanout`;
  }
  return {
    fanout: true,
    workpool: true,
    taskGroupPool: taskGroupPoolReason === undefined,
    ...(taskGroupPoolReason !== undefined ? { taskGroupPoolReason } : {}),
    summarize: config.summarize.enabled,
    structured: true,
    joinAll: true,
    joinAny: true,
    joinQuorum: true,
    rpcUi: false,
    notes: [
      "compiled through the standard native eval tool",
      "final result is decoded from native details.cells[].views[].view.value for foreground groups",
      "explicit background groups use a short Workpool dispatch cell plus an explicit collect cell after OMP's native async-result notice, then read one atomic SHA-256-checked private file through task_group_result",
      "background dispatch success requires verified push() item ids in the cell receipt; details.async is never treated as success",
      "Pool preflight checks proc://, wait(), status(), peek(), and exact item coverage before returning one result",
      ...(taskGroupPoolReason !== undefined ? [taskGroupPoolReason] : []),
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

function isExpectedInput(input: unknown, pending: PendingCall): boolean {
  return (
    isRecord(input) &&
    input.language === "js" &&
    input.timeout === 0 &&
    input.code === pending.rewrittenInput.code &&
    (input.reset === true) === (pending.rewrittenInput.reset === true)
  );
}

interface EmbeddedCollectIdentity {
  groupId: string;
  resultId: string;
}

/**
 * OMP may persist the effective rewritten Eval source in the transcript.
 * Recognize only a compiled collect-shaped retry, then compare it byte-for-byte
 * to the last issued source before replacing its one-use capability.
 */
function embeddedCollectIdentity(code: unknown): EmbeddedCollectIdentity | undefined | null {
  if (typeof code !== "string") return undefined;
  const marker = `const TG_BG_TRANSPORT = ${JSON.stringify(POOL_BACKGROUND_COLLECT_TRANSPORT)};`;
  if (!code.includes(marker)) return undefined;
  const groupMatch = code.match(/const TG_GROUP = ("(?:\\.|[^"\\])*");/);
  const resultMatch = code.match(/const TG_BG_RESULT = (\{[^\n]*\});/);
  if (groupMatch === null || resultMatch === null) return null;
  try {
    const groupId: unknown = JSON.parse(groupMatch[1] as string);
    const result: unknown = JSON.parse(resultMatch[1] as string);
    if (
      typeof groupId !== "string" ||
      !isRecord(result) ||
      typeof result.resultId !== "string" ||
      typeof result.path !== "string" ||
      typeof result.storeCapability !== "string" ||
      !/^[a-f0-9]{64}$/.test(result.storeCapability) ||
      Object.keys(result).length !== 3
    ) {
      return null;
    }
    return { groupId, resultId: result.resultId };
  } catch {
    return null;
  }
}

function backgroundedReason(details: unknown, backgroundRequested = false): string | undefined {
  if (!isRecord(details) || !isRecord(details.async)) return undefined;
  const jobId = typeof details.async.jobId === "string" ? ` (${details.async.jobId})` : "";
  return [
    `native eval was auto-backgrounded${jobId}`,
    backgroundRequested
      ? "the dispatch cell's verified push receipt was not delivered, so dispatch is unconfirmed and is never treated as success; if the cell ran, its pool items may still be running — do not re-dispatch"
      : "while this group required one foreground result",
    backgroundRequested
      ? "after OMP's native async-result notice, run the explicit ompTaskGroupCollect envelope to inspect the retained handle"
      : "OMP will deliver the cell output later as a separate async-result text preview, but no Task Group Result Gate or bounded digest was produced, and the plugin did not cancel the host-owned job",
    backgroundRequested
      ? "a foreground group should set eval.autoBackground.enabled=false"
      : 'for a foreground group set eval.autoBackground.enabled=false; for two-phase background use background:"require" or execution.mode:"background"',
  ].join("; ");
}

function backgroundToolError(message: string): AgentToolResult {
  return {
    content: [{ type: "text", text: `Task Group background result error: ${message}` }],
    details: { protocol: BACKGROUND_DETAILS_PROTOCOL, error: message },
    isError: true,
  };
}

function backgroundToolFailure(error: unknown): AgentToolResult {
  if (
    error instanceof BackgroundResultIntegrityError ||
    error instanceof BackgroundResultPendingError ||
    error instanceof BackgroundResultStateError ||
    error instanceof EvalResultError
  ) {
    return backgroundToolError(error.message);
  }
  return backgroundToolError(error instanceof Error ? error.message : String(error));
}

function renderBackgroundStatus(status: {
  resultId: string;
  groupId: string;
  state: string;
  path: string;
  expiresInMs: number;
  retentionMs: number;
  fileBytes?: number;
  checksum?: string;
  payloadChars?: number;
  deliveredChars?: number;
  totalChars?: number;
}): string {
  const ttlMinutes = Math.max(0, Math.ceil(status.expiresInMs / 60_000));
  const retentionMinutes = Math.max(0, Math.round(status.retentionMs / 60_000));
  const progress =
    status.totalChars !== undefined
      ? ` · delivered ${status.deliveredChars ?? 0}/${status.totalChars} chars`
      : "";
  const lines = [
    `Background result ${status.resultId} (${status.groupId}): state=${status.state}${progress} · ttl=${ttlMinutes}m · retention=${retentionMinutes}m`,
    `path: ${status.path}`,
  ];
  if (status.checksum !== undefined) lines.push(`sha256: ${status.checksum}`);
  if (status.fileBytes !== undefined) lines.push(`file bytes: ${status.fileBytes}`);
  if (status.state === "pending") {
    lines.push(
      "No valid result file exists yet. The Workpool may still be draining, or the explicit ompTaskGroupCollect step has not run. This is not a success.",
    );
    lines.push(
      `Result retention is ${retentionMinutes}m (background.retentionMinutes from this group's cwd config) and starts when collect writes the file; the pending deadline is separate and unchanged.`,
    );
  } else if (status.state === "ready") {
    lines.push('The file exists; call action="read" to verify it and receive the gated result in segments.');
    lines.push(
      `The observed-result window is ${retentionMinutes}m (background.retentionMinutes from this group's cwd config; default 30, range 1-1440).`,
    );
  } else {
    lines.push('Call action="read" until complete=true, then action="consume" to delete the private file.');
  }
  return lines.join("\n");
}

function configForCwd(cwd: string, fallback: TaskGroupConfig): TaskGroupConfig {
  try {
    return loadConfig(cwd);
  } catch {
    return fallback;
  }
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
  const pendingCalls = new Map<string, PendingCall>();
  const activeCollectCalls = new Set<string>();
  const hasActiveCollect = (groupId: string, resultId: string, storeCapability: string): boolean => {
    if (!/^[a-f0-9]{64}$/.test(storeCapability)) return false;
    for (const toolCallId of activeCollectCalls) {
      const pending = pendingCalls.get(toolCallId);
      if (
        pending?.kind === "collect" &&
        pending.groupId === groupId &&
        pending.resultId === resultId &&
        pending.storeCapability === storeCapability
      ) {
        return true;
      }
    }
    return false;
  };
  let lastPlan: PlanResult | undefined;
  const detector = new MissedGroupDetector(fallbackConfig, () => telemetry.recordMissedGroupCandidate());

  // ── Background result store (lazy, session-scoped) ────────────────
  let resultStore: BackgroundResultStore | undefined;
  const liveResultStore = (): BackgroundResultStore | undefined => resultStore;
  const getResultStore = (): BackgroundResultStore => {
    if (resultStore === undefined) resultStore = new BackgroundResultStore();
    return resultStore;
  };
  const closeResultStore = (): void => {
    try {
      resultStore?.dispose();
    } catch (error) {
      pi.logger?.warn(
        `omp-task-group background cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    resultStore = undefined;
  };
  const discardPendingBackground = (pending: PendingGroupCall): void => {
    if (pending.background === undefined) return;
    try {
      liveResultStore()?.discard(pending.background.resultId);
    } catch (error) {
      pi.logger?.warn(
        `omp-task-group background discard failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  try {
    sweepStaleBackgroundResultDirs();
  } catch (error) {
    pi.logger?.warn(
      `omp-task-group stale background sweep failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const finalizeDecodedGroup = async (
    target: FinalizeTarget,
    result: GroupRunResult,
  ): Promise<RunOutcome> => {
    const backend: TaskGroupBackend = {
      capabilities: () => target.capabilities,
      runGroup: async () => result,
    };
    return await runTaskGroup({
      spec: target.spec,
      config: target.config,
      backend,
      signal: undefined,
      onUpdate: undefined,
      telemetry,
      groupId: target.groupId,
      plan: target.plan,
    });
  };

  // ── Model-facing read/consume tool for background results ─────────
  pi.registerTool({
    name: "task_group_result",
    label: "Task Group Result",
    description:
      "Read or consume a two-phase Workpool background Task Group result after ompTaskGroupCollect wrote it. Use the tgbg_ id from the dispatch receipt. action=\"read\" returns the shared Result Gate text in bounded segments (call again without offset until complete=true); action=\"status\" reports pending/ready/materialized, TTL, and the configured observed-result retention (background.retentionMinutes from the group's own cwd config; default 30, range 1-1440); action=\"consume\" deletes the private result file only after every character was delivered. Repeating action=\"consume\" for an already consumed id returns a non-error already-consumed receipt and deletes nothing again; an id never consumed in this session remains a not-found error. This tool never accepts a path and only touches plugin-registered files.",
    approval: "read",
    parameters: pi.zod.object({
      action: pi.zod.string().describe('"read" to receive the next gated segment, "status" for state/TTL, or "consume" to delete after a full read; repeating consume for an already consumed id is a no-op receipt'),
      id: pi.zod.string().describe("Background result id (tgbg_...) from the Task Group background notice"),
      offset: pi.zod.number().optional().describe("Optional character offset to re-read a delivered segment; omit to continue sequentially"),
    }),
    execute: async (_toolCallId, params): Promise<AgentToolResult> => {
      const action = typeof params.action === "string" ? params.action.trim() : "";
      const id = typeof params.id === "string" ? params.id.trim() : "";
      if (action !== "read" && action !== "status" && action !== "consume") {
        return backgroundToolError('action must be "read", "status", or "consume"');
      }
      if (id.length === 0) return backgroundToolError("id is required");
      const store = liveResultStore();
      if (store === undefined) {
        return backgroundToolError("no background Task Group result has been registered in this session");
      }
      let offset: number | undefined;
      if (params.offset !== undefined) {
        if (typeof params.offset !== "number" || !Number.isInteger(params.offset) || params.offset < 0) {
          return backgroundToolError("offset must be a non-negative integer character offset");
        }
        offset = params.offset;
      }

      if (action === "status") {
        try {
          const status = store.status(id);
          return {
            content: [{ type: "text", text: renderBackgroundStatus(status) }],
            details: { protocol: BACKGROUND_DETAILS_PROTOCOL, ...status },
            isError: false,
          };
        } catch (error) {
          return backgroundToolFailure(error);
        }
      }

      if (action === "consume") {
        try {
          const consumed = store.consume(id);
          if ("alreadyConsumed" in consumed) {
            return {
              content: [
                {
                  type: "text",
                  text: `Background result ${consumed.resultId} (${consumed.groupId}) was already consumed; its private result file is already deleted or absent. Nothing was deleted again and no result content is re-delivered.\npath: ${consumed.path}\nsha256: ${consumed.checksum}`,
                },
              ],
              details: { protocol: BACKGROUND_DETAILS_PROTOCOL, ...consumed },
              isError: false,
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `Background result ${consumed.resultId} consumed (${consumed.deleted ? "file deleted" : "file was already absent"}): ${consumed.path}\nsha256: ${consumed.checksum}`,
              },
            ],
            details: { protocol: BACKGROUND_DETAILS_PROTOCOL, ...consumed },
            isError: false,
          };
        } catch (error) {
          return backgroundToolFailure(error);
        }
      }

      let materialized: BackgroundResultMaterialized;
      try {
        materialized = await store.materialize(id, async (file) => {
          const result = decodeEvalPayload(file.payload, file.record.spec, file.record.groupId);
          const outcome = await finalizeDecodedGroup(file.record, result);
          lastPlan = outcome.plan;
          return { text: outcome.text, details: outcome.details, isError: outcome.isError };
        });
      } catch (error) {
        if (error instanceof BackgroundResultPendingError) {
          let path: string | undefined;
          let groupId: string | undefined;
          try {
            const record = store.get(id);
            path = record.path;
            groupId = record.groupId;
          } catch {
            path = undefined;
            groupId = undefined;
          }
          return {
            content: [
              {
                type: "text",
                text: `Background result ${id} is not ready: no valid result file exists yet. The Workpool may still be draining, or the explicit ompTaskGroupCollect step has not run. This is not a completed Task Group result; use action="status" for TTL information.`,
              },
            ],
            details: {
              protocol: BACKGROUND_DETAILS_PROTOCOL,
              resultId: id,
              state: "pending",
              ...(groupId !== undefined ? { groupId } : {}),
              ...(path !== undefined ? { path } : {}),
            },
            isError: false,
          };
        }
        return backgroundToolFailure(error);
      }

      try {
        const segment = store.readSegment(id, offset);
        const header = `Background Task Group result · ${segment.resultId} · chars ${segment.offset}-${segment.end}/${segment.total} · sha256 ${segment.checksum.slice(0, 16)}…`;
        const footer = segment.complete
          ? `\n\n[all ${segment.total} characters delivered; call task_group_result action="consume" to delete ${segment.path}]`
          : "";
        return {
          content: [{ type: "text", text: `${header}\n\n${segment.text}${footer}` }],
          details: {
            ...materialized.details,
            background: {
              protocol: BACKGROUND_DETAILS_PROTOCOL,
              requested: true,
              delivery: "background-file",
              state: "materialized",
              resultId: segment.resultId,
              groupId: segment.groupId,
              path: segment.path,
              checksum: segment.checksum,
              payloadChars: materialized.payloadChars,
              offset: segment.offset,
              end: segment.end,
              deliveredChars: segment.deliveredChars,
              totalChars: segment.total,
              complete: segment.complete,
            },
          },
          isError: materialized.isError,
        };
      } catch (error) {
        return backgroundToolFailure(error);
      }
    },
  });

  // ── Write-approved store used only by the collect cell ────────────
  // The collect cell has no filesystem I/O. This tool accepts no path and
  // writes only a registered group's own result after validating identity,
  // protocol, gate text, and size. A failed write never returns ready.
  pi.registerTool({
    name: "task_group_store_result",
    label: "Task Group Store Result",
    description:
      "Internal write-approval tool for the background Task Group collect cell. It accepts only a registered groupId, resultId, an in-memory collect capability, and bounded payloadJson from the shared Result Gate. No file path is accepted. It verifies the active collect capability, group ownership, payload protocol, deterministic gate text, and size, then writes one atomic SHA-256-checked private file. Direct calls are blocked.",
    approval: "write",
    parameters: pi.zod.object({
      groupId: pi.zod.string().describe("Registered Task Group id from the dispatch receipt"),
      resultId: pi.zod.string().describe("Registered background result id (tgbg_...) from the dispatch receipt"),
      storeCapability: pi.zod.string().describe("In-memory capability bound to the active compiled Collect Eval"),
      payloadJson: pi.zod.string().describe("Serialized bounded collect payload produced by the shared Result Gate"),
    }),
    execute: async (_toolCallId, params): Promise<AgentToolResult> => {
      const groupId = typeof params.groupId === "string" ? params.groupId.trim() : "";
      const resultId = typeof params.resultId === "string" ? params.resultId.trim() : "";
      const storeCapability = typeof params.storeCapability === "string" ? params.storeCapability : "";
      const payloadJson = typeof params.payloadJson === "string" ? params.payloadJson : "";
      if (groupId.length === 0 || resultId.length === 0) {
        return backgroundToolError("groupId and resultId are required");
      }
      if (!hasActiveCollect(groupId, resultId, storeCapability)) {
        return backgroundToolError(
          "task_group_store_result requires the capability from the currently executing matching ompTaskGroupCollect Eval",
        );
      }
      if (payloadJson.length === 0) return backgroundToolError("payloadJson is required");
      const store = liveResultStore();
      if (store === undefined) {
        return backgroundToolError("no background Task Group result has been registered in this session");
      }
      try {
        const stored = store.storeVerifiedPayload({ groupId, resultId, payloadJson });
        return {
          content: [
            {
              type: "text",
              text: `Background Task Group result stored and verified: ${stored.resultId} (${stored.groupId})${stored.alreadyStored ? " [identical retry]" : ""}\npath: ${stored.path}\nsha256: ${stored.checksum}\npayloadChars: ${stored.payloadChars}`,
            },
          ],
          details: { protocol: BACKGROUND_DETAILS_PROTOCOL, state: "ready", ...stored },
          isError: false,
        };
      } catch (error) {
        return backgroundToolFailure(error);
      }
    },
  });

  const collectEnvelopeText = (groupId: string, resultId: string): string =>
    `ompTaskGroupCollect(${JSON.stringify({ groupId, resultId })})`;

  const dispatchedPatch = (
    pending: PendingGroupCall,
    record: BackgroundResultRecord,
    receipt: PoolBackgroundDispatchReceipt,
  ): ToolResultPatch => {
    const collect = collectEnvelopeText(pending.groupId, record.resultId);
    const shown = receipt.itemIds.slice(0, 12).join(", ");
    const more = receipt.itemIds.length > 12 ? ` … (+${receipt.itemIds.length - 12} more)` : "";
    const retentionMinutes = pending.config.background.retentionMinutes;
    const store = liveResultStore();
    return {
      content: [
        {
          type: "text",
          text: [
            "Task Group dispatched to a native Workpool in the background — this is not a result yet.",
            `group: ${pending.groupId} · strategy: pool · tasks: ${receipt.taskCount} · resultId: ${record.resultId}`,
            `pool: ${receipt.poolName} · item ids: ${shown}${more}`,
            "The dispatch cell returned after verified push() ids. It did not call wait(), did not start a plugin watch promise, and sent no plugin notification.",
            "OMP delivers its own async-result notice when the pool settles. That native preview may contain ungated aggregate child text; it is not the Task Group result.",
            `After that notice, collect with eval language "js", timeout 0 (do not reset the kernel): ${collect}`,
            "collect reads only the retained pool handle's status()/peek(). While the pool is still draining it reports pending and never waits, and it never consumes another job.",
            `When collect reports ready, read the gated result with task_group_result {"action":"read","id":"${record.resultId}"} until complete=true, then action="consume".`,
            `Result retention: ${retentionMinutes} min after the file first appears; the pending deadline is separate.`,
          ].join("\n"),
        },
      ],
      details: {
        protocol: "omp-task-group/v1",
        groupId: pending.groupId,
        state: "dispatched",
        background: {
          protocol: BACKGROUND_DETAILS_PROTOCOL,
          requested: true,
          delivery: "workpool-async",
          state: "dispatched",
          groupId: pending.groupId,
          resultId: record.resultId,
          poolName: receipt.poolName,
          itemIds: receipt.itemIds,
          taskCount: receipt.taskCount,
          collect,
          path: record.path,
          ttlMs: retentionMinutes * 60_000,
          retentionMs: retentionMinutes * 60_000,
          retentionMinutes,
          pendingTtlMs: store?.pendingTtlMs ?? record.expiresAtMs - record.createdAtMs,
        },
      },
      isError: false,
    };
  };

  const dispatchFailurePatch = (
    pending: PendingGroupCall,
    receipt: { stage: string; reason: string; dispatched: boolean; cancelled?: boolean; cancelError?: string },
  ): ToolResultPatch => {
    const record = pending.background;
    const lines = [
      `Task Group background dispatch failed (stage: ${receipt.stage}): ${receipt.reason}`,
      receipt.dispatched
        ? "push() may have started pool items; tasks were not rerun."
        : "No pool item was dispatched.",
      receipt.cancelled === true
        ? "Cancellation of the attempted pool was confirmed."
        : receipt.cancelled === false
          ? "Cancellation could NOT be confirmed; inspect proc:// before any retry."
          : "",
      "No background result file will be written for a failed dispatch.",
    ].filter((line) => line.length > 0);
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: {
        protocol: "omp-task-group/v1",
        groupId: pending.groupId,
        isError: true,
        error: receipt.reason,
        background: {
          protocol: BACKGROUND_DETAILS_PROTOCOL,
          requested: true,
          delivery: "workpool-async",
          state: "failed",
          stage: receipt.stage,
          reason: receipt.reason,
          dispatched: receipt.dispatched,
          ...(record !== undefined ? { resultId: record.resultId, groupId: pending.groupId, path: record.path } : {}),
          ...(receipt.cancelled !== undefined ? { cancelled: receipt.cancelled } : {}),
          ...(receipt.cancelError !== undefined ? { cancelError: receipt.cancelError } : {}),
        },
      },
      isError: true,
    };
  };

  const collectPendingPatch = (
    pending: PendingCollectCall,
    record: BackgroundResultRecord,
    receipt: PoolBackgroundCollectReceipt,
  ): ToolResultPatch => {
    const counts = receipt.counts ?? { succeeded: 0, failed: 0, cancelled: 0 };
    return {
      content: [
        {
          type: "text",
          text: [
            `Background group ${pending.groupId} is still draining (result ${pending.resultId}). This is not a result.`,
            receipt.reason !== undefined ? `state: pending · ${receipt.reason}` : "state: pending",
            `settled so far: ${counts.succeeded} succeeded, ${counts.failed} failed, ${counts.cancelled} cancelled` +
              (receipt.pool !== undefined
                ? ` · pool: queued ${receipt.pool.queued}, running ${receipt.pool.running}, closed ${receipt.pool.closed}, pending ${receipt.pool.pending}`
                : ""),
            "collect did not wait and consumed no other job. Call the same collect envelope again after OMP's native async-result notice.",
            `collect: ${collectEnvelopeText(pending.groupId, record.resultId)}`,
          ].join("\n"),
        },
      ],
      details: {
        protocol: "omp-task-group/v1",
        groupId: pending.groupId,
        resultId: pending.resultId,
        background: {
          protocol: BACKGROUND_DETAILS_PROTOCOL,
          requested: true,
          delivery: "workpool-async",
          state: "pending",
          groupId: pending.groupId,
          resultId: pending.resultId,
          path: record.path,
          counts,
          ...(receipt.pool !== undefined ? { pool: receipt.pool } : {}),
          ...(receipt.reason !== undefined ? { reason: receipt.reason } : {}),
        },
      },
      isError: false,
    };
  };

  const collectReadyPatch = (
    pending: PendingCollectCall,
    record: BackgroundResultRecord,
    receipt: PoolBackgroundCollectReceipt,
  ): ToolResultPatch => {
    const counts = receipt.counts ?? { succeeded: 0, failed: 0, cancelled: 0 };
    const groupState = receipt.groupState ?? "failed";
    return {
      content: [
        {
          type: "text",
          text: [
            `Background Task Group collected and verified: ${pending.resultId} (${pending.groupId}).`,
            `groupState: ${groupState} · ${counts.succeeded} succeeded, ${counts.failed} failed, ${counts.cancelled} cancelled` +
              (receipt.pool !== undefined
                ? ` · pool items completed ${receipt.pool.completed}, failed ${receipt.pool.failed}, cancelled ${receipt.pool.cancelled}`
                : ""),
            `path: ${record.path}`,
            `chars: ${receipt.payloadChars ?? 0} · sha256: ${receipt.checksum ?? ""}`,
            groupState === "completed"
              ? "The collection completed; the group succeeded."
              : `The gate reports this group as ${groupState}; the file is available but this is not a success.`,
            `Read the gated result with task_group_result {"action":"read","id":"${record.resultId}"} until complete=true, then delete the private file with action="consume".`,
          ].join("\n"),
        },
      ],
      details: {
        protocol: "omp-task-group/v1",
        groupId: pending.groupId,
        resultId: pending.resultId,
        state: groupState,
        ...(groupState !== "completed" ? { gate: groupState } : {}),
        background: {
          protocol: BACKGROUND_DETAILS_PROTOCOL,
          requested: true,
          delivery: "workpool-async",
          state: "ready",
          groupId: pending.groupId,
          resultId: pending.resultId,
          groupState,
          counts,
          ...(receipt.pool !== undefined ? { pool: receipt.pool } : {}),
          path: record.path,
          checksum: receipt.checksum,
          payloadChars: receipt.payloadChars,
        },
      },
      isError: groupState !== "completed",
    };
  };

  const collectFailurePatch = (
    pending: PendingCollectCall,
    record: BackgroundResultRecord,
    receipt: PoolBackgroundCollectReceipt,
  ): ToolResultPatch => {
    const reason = receipt.reason ?? "the collect cell reported a failure";
    const stage = receipt.stage ?? "unknown";
    return {
      content: [
        {
          type: "text",
          text: [
            `Background collect failed (stage: ${stage}): ${reason}`,
            "No result file was written by this attempt; no child task was rerun.",
            stage === "handle"
              ? "The retained Workpool handle is unavailable (kernel reset, different session, or dispatch never completed). The pool may still be running; do not re-dispatch without inspecting proc://."
              : "The retained pool handle is kept so a later collect can retry; use task_group_result status or proc:// to inspect the group.",
            `collect: ${collectEnvelopeText(pending.groupId, record.resultId)}`,
          ].join("\n"),
        },
      ],
      details: {
        protocol: "omp-task-group/v1",
        groupId: pending.groupId,
        resultId: pending.resultId,
        background: {
          protocol: BACKGROUND_DETAILS_PROTOCOL,
          requested: true,
          delivery: "workpool-async",
          state: "failed",
          stage,
          reason,
          groupId: pending.groupId,
          resultId: pending.resultId,
          path: record.path,
          ...(receipt.counts !== undefined ? { counts: receipt.counts } : {}),
          ...(receipt.pool !== undefined ? { pool: receipt.pool } : {}),
        },
      },
      isError: true,
    };
  };

  // ── Smart Dispatcher: policy injection (suggest default) ──────────
  pi.on("before_agent_start", (event, ctx) => injectPolicy(event, configForCwd(ctx.cwd, fallbackConfig)));

  // ── Missed-group telemetry (post-hoc only) ────────────────────────
  pi.on("turn_start", () => detector.onTurnStart());
  pi.on("turn_end", () => detector.onTurnEnd());
  pi.on("tool_execution_start", (event) => detector.onToolExecutionStart(event.toolName, event.toolCallId, event.intent));
  pi.on("tool_execution_end", (event) => {
    activeCollectCalls.delete(event.toolCallId);
    detector.onToolExecutionEnd(event.toolCallId);
  });

  // ── Telemetry rehydrate per session ───────────────────────────────
  const onSessionOpen = (ctx: ExtensionContext): void => {
    pendingCalls.clear();
    activeCollectCalls.clear();
    closeResultStore();
    detector.setConfig(configForCwd(ctx.cwd, fallbackConfig));
    telemetry.rehydrate(ctx.sessionManager.getBranch());
  };
  pi.on("session_start", (_event, ctx) => onSessionOpen(ctx));
  pi.on("session_switch", (_event, ctx) => onSessionOpen(ctx));
  pi.on("session_branch", (_event, ctx) => onSessionOpen(ctx));
  pi.on("session_tree", (_event, ctx) => onSessionOpen(ctx));
  pi.on("session_shutdown", () => {
    pendingCalls.clear();
    activeCollectCalls.clear();
    closeResultStore();
  });

  // Store writes are accepted only while the matching validated Collect Eval
  // is executing. This lets the public Eval tool bridge invoke the write tier
  // while preventing direct model calls from fabricating result snapshots.
  pi.on("tool_call", (event) => {
    if (event.toolName !== "task_group_store_result") return undefined;
    const groupId = typeof event.input.groupId === "string" ? event.input.groupId : "";
    const resultId = typeof event.input.resultId === "string" ? event.input.resultId : "";
    const storeCapability = typeof event.input.storeCapability === "string" ? event.input.storeCapability : "";
    if (!hasActiveCollect(groupId, resultId, storeCapability)) {
      return block("task_group_store_result requires the active matching Collect Eval capability");
    }
  });

  // ── Enforce-mode guard: block an obviously-batched native task call ─
  pi.on("tool_call", (event, ctx) => {
    if (configForCwd(ctx.cwd, fallbackConfig).dispatcher.mode !== "enforce") return undefined;
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

    const collectEnvelope = parseTaskGroupCollectEnvelope(event.input.code);
    const embeddedCollect = embeddedCollectIdentity(event.input.code);
    if (embeddedCollect === null) {
      return block("Task Group compiled collect code is malformed; do not run modified generated code");
    }
    if (collectEnvelope.kind === "malformed") {
      return block(`Task Group collect envelope invalid: ${collectEnvelope.error.message}`);
    }
    const collectIdentity =
      collectEnvelope.kind === "valid"
        ? collectEnvelope.spec
        : embeddedCollect ?? undefined;
    if (collectIdentity !== undefined) {
      if (event.input.language !== "js") {
        return block('Task Group collect envelope requires standard eval with language "js"');
      }
      if (event.input.reset === true) {
        return block(
          "Task Group collect must run in the eval kernel that retains the Workpool handle; reset:true would drop the handle and any other live background group. Remove reset and retry.",
        );
      }
      const collectBarrier = scanAutoBackgroundConfig(ctx.cwd, { mode: ctx.mode });
      if (!collectBarrier.allow) {
        return block(
          `Task Group collect requires a foreground Eval cell: ${collectBarrier.reason ?? "eval.autoBackground could not be verified as disabled"}`,
        );
      }
      let collectConfig: TaskGroupConfig;
      try {
        collectConfig = loadConfig(ctx.cwd);
      } catch (error) {
        const message = error instanceof ConfigLoadError ? error.message : String(error);
        return block(`omp-task-group configuration error: ${message}`);
      }
      if (!collectConfig.enabled) {
        return block("omp-task-group is disabled by config (enabled=false)");
      }
      const store = liveResultStore();
      if (store === undefined) {
        return block("Task Group collect cannot recover this result: no background result is registered in this session. It may have expired or belonged to a different session; do not re-dispatch already started tasks.");
      }
      let record: BackgroundResultRecord;
      try {
        record = store.get(collectIdentity.resultId);
      } catch (error) {
        return block(
          `Task Group collect rejected: ${error instanceof Error ? error.message : String(error)}. A session switch, expiry, or prior consumption may make the result unavailable; do not re-dispatch already started tasks.`,
        );
      }
      if (record.groupId !== collectIdentity.groupId) {
        return block(
          `Task Group collect groupId does not match the registered result: expected ${record.groupId}, got ${collectIdentity.groupId}`,
        );
      }
      if (record.plan.strategy !== "pool") {
        return block("Task Group collect only accepts groups dispatched through the native Workpool background path");
      }
      if (embeddedCollect !== undefined) {
        if (record.storeCapability === undefined) {
          return block("Task Group compiled collect code is not registered for this result; refusing replay");
        }
        let previousCode: string;
        try {
          previousCode = compilePoolBackgroundCollectProgram(record.spec, {
            groupId: record.groupId,
            collect: {
              resultId: record.resultId,
              path: record.path,
              storeCapability: record.storeCapability,
            },
          });
        } catch (error) {
          return block(`Task Group collect compile failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (previousCode !== event.input.code) {
          return block("Task Group compiled collect code does not match the registered group; refusing modified Eval code");
        }
      }

      const storeCapability = randomBytes(32).toString("hex");
      let collectCode: string;
      try {
        collectCode = compilePoolBackgroundCollectProgram(record.spec, {
          groupId: record.groupId,
          collect: {
            resultId: record.resultId,
            path: record.path,
            storeCapability,
          },
        });
      } catch (error) {
        return block(`Task Group collect compile failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      record.storeCapability = storeCapability;
      const collectInput: Record<string, unknown> = {
        language: "js",
        code: collectCode,
        title: `task group collect: ${record.groupId}`,
        timeout: 0,
      };
      pendingCalls.set(event.toolCallId, {
        kind: "collect",
        groupId: record.groupId,
        resultId: record.resultId,
        storeCapability,
        rewrittenInput: collectInput,
      });
      return { input: collectInput };
    }

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

    let spec: TaskGroupSpec;
    try {
      spec = normalizeSpec(envelope.spec, config);
    } catch (error) {
      return block(`Task Group spec invalid: ${error instanceof Error ? error.message : String(error)}`);
    }

    const backgroundRequested = isBackgroundRequested(spec);
    const barrier = scanAutoBackgroundConfig(ctx.cwd, { mode: ctx.mode });
    if (backgroundRequested) {
      if (event.input.reset === true) {
        return block(
          "Task Group background dispatch must preserve the shared eval kernel that retains the Workpool handle. Remove reset:true; reset would also drop any other live background group.",
        );
      }
      if (spec.output.mode === "summarize") {
        return block(
          'Task Group background cannot run a summarizer (collect must never wait). Use output.mode="compact" | "structured", or run this group in the foreground.',
        );
      }
    } else if (!barrier.allow) {
      return block(
        [
          "Task Group requires one foreground native eval result: " +
            (barrier.reason ?? "eval.autoBackground could not be verified as disabled"),
          "",
          formatBarrierDiagnosis(barrier),
          "",
          "Fix (foreground): explicitly set eval.autoBackground.enabled=false in the active agent config, project config, or a --config overlay, then retry.",
          'To use the two-phase Workpool background protocol instead, opt in explicitly with background:"require" or execution.mode:"background"; it does not depend on eval.autoBackground.',
        ].join("\n"),
      );
    }

    const groupId = newGroupId();
    const capabilities = nativeEvalCapabilities(config, pi);
    const plan = planExecution(spec, capabilities, {
      enabled: config.execution.pool.enabled,
      threshold: config.execution.pool.threshold,
      background: backgroundRequested,
    });
    if (backgroundRequested && plan.strategy !== "pool") {
      return block(
        [
          "Task Group background requires the native Workpool path, but this spec cannot produce a pool plan:",
          plan.fallbackReason ?? "the planner did not select the pool strategy",
          "",
          ...plan.reasons.map((reason) => `- ${reason}`),
          "",
          "Background requires homogeneous join=all + failure=collect tasks, identical agents/tools, execution.concurrency=auto, no per-task schema or isolation, and a pool-enabled config.",
          "Background never falls back to Fanout and never waits inside the dispatch cell.",
        ].join("\n"),
      );
    }
    let backgroundRecord: BackgroundResultRecord | undefined;
    if (backgroundRequested) {
      try {
        backgroundRecord = getResultStore().register({ groupId, spec, config, plan, capabilities });
      } catch (error) {
        return block(
          `Task Group background setup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    let code: string;
    try {
      if (backgroundRequested && backgroundRecord !== undefined) {
        code = compilePoolBackgroundDispatchProgram(spec, {
          groupId,
          background: { resultId: backgroundRecord.resultId },
        });
      } else {
        const compileOptions = {
          groupId,
          ...(config.summarize.enabled ? { summarize: { model: config.summarize.model } } : {}),
          ...(plan.fallbackReason !== undefined ? { fallbackReason: plan.fallbackReason } : {}),
        };
        code =
          plan.strategy === "pool"
            ? compilePoolProgram(spec, compileOptions)
            : compileFanoutProgram(spec, compileOptions);
      }
    } catch (error) {
      if (backgroundRecord !== undefined) {
        try {
          getResultStore().discard(backgroundRecord.resultId);
        } catch {
          // The record expires with its TTL; the compile failure is the primary error.
        }
      }
      return block(`Task Group compile failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const rewrittenInput: Record<string, unknown> = {
      language: "js",
      code,
      title:
        backgroundRequested && backgroundRecord !== undefined
          ? `task group background dispatch: ${groupId}`
          : typeof event.input.title === "string" ? event.input.title : `task group: ${spec.label ?? groupId}`,
      timeout: 0,
      // Background dispatch must keep the kernel so the retained handle can be
      // collected later; never propagate reset for a two-phase call.
      ...(!backgroundRequested && event.input.reset === true ? { reset: true } : {}),
    };

    pendingCalls.set(event.toolCallId, {
      kind: "group",
      spec,
      config,
      groupId,
      plan,
      capabilities,
      rewrittenInput,
      ...(backgroundRecord !== undefined ? { background: backgroundRecord } : {}),
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
    if (pending === undefined) return;
    if (!isExpectedInput(event.args, pending)) {
      pending.collisionReason =
        "another extension replaced the Task Group compiled eval input after envelope recognition";
      ctx.abort();
      return;
    }
    if (pending.kind === "collect") activeCollectCalls.add(event.toolCallId);
  });

  // ── Final result decoding + single joined delivery ─────────────────
  pi.on("tool_result", async (event: ToolResultEvent): Promise<ToolResultPatch | undefined> => {
    if (event.toolName !== "eval") return undefined;
    const pending = pendingCalls.get(event.toolCallId);
    if (pending === undefined) return undefined;
    pendingCalls.delete(event.toolCallId);
    activeCollectCalls.delete(event.toolCallId);

    if (pending.collisionReason !== undefined) {
      if (pending.kind === "group") discardPendingBackground(pending);
      return resultError(`${pending.collisionReason}; the eval run was aborted before Task Group execution`);
    }
    if (!isExpectedInput(event.input, pending)) {
      if (pending.kind === "group") discardPendingBackground(pending);
      return resultError("another extension changed the Task Group effective eval input; refusing to interpret its result");
    }

    // ── Explicit collect cell ───────────────────────────────────────
    if (pending.kind === "collect") {
      if (isRecord(event.details) && Boolean(event.details.async)) {
        return resultError(
          "native eval auto-backgrounded the collect cell; its in-cell receipt is unavailable and this is not a result. Do not treat the native notification as the collected result.",
        );
      }
      if (event.isError) {
        const nativeError = event.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n")
          .trim();
        return resultError(
          nativeError.length > 0
            ? `native eval failed during collect: ${nativeError.slice(0, 800)}`
            : "native eval failed before the collect cell produced a receipt",
        );
      }
      const store = liveResultStore();
      if (store === undefined) {
        return resultError("the background result store is unavailable; no collectable result remains in this session");
      }
      let record: BackgroundResultRecord;
      try {
        record = store.get(pending.resultId);
      } catch (error) {
        return resultError(
          `background collect receipt cannot be applied: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      let receipt: PoolBackgroundCollectReceipt;
      try {
        receipt = decodePoolBackgroundCollect(event.details, {
          groupId: pending.groupId,
          resultId: pending.resultId,
          path: record.path,
        });
      } catch (error) {
        return resultError(
          `background collect cell returned no valid collect receipt: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (receipt.state === "pending") {
        return collectPendingPatch(pending, record, receipt);
      }
      if (receipt.state === "failed") {
        return collectFailurePatch(pending, record, receipt);
      }
      let file;
      try {
        file = store.readVerified(pending.resultId);
      } catch (error) {
        return resultError(
          `background collect reported ready, but the result file could not be verified: ${error instanceof Error ? error.message : String(error)}. This is not a completed result.`,
        );
      }
      const payloadGroupState = file.payload.groupState;
      if (
        payloadGroupState !== receipt.groupState ||
        file.checksum !== receipt.checksum ||
        file.payloadChars !== receipt.payloadChars
      ) {
        return resultError(
          "background collect receipt does not match the verified result file (group state, checksum, or length mismatch); refusing to report a result",
        );
      }
      return collectReadyPatch(pending, record, receipt);
    }

    // ── Dispatch or one-shot foreground group cell ─────────────────
    const hasNativeAsync = isRecord(event.details) && Boolean(event.details.async);
    if (hasNativeAsync) {
      // A two-phase background dispatch must return its own verified push
      // receipt. details.async only proves the host backgrounded this control
      // cell; it is never dispatch success. The record is kept so a later
      // collect can still inspect a handle that did run.
      const reason = backgroundedReason(event.details, pending.background !== undefined) ?? "native eval was backgrounded";
      return resultError(
        pending.background === undefined
          ? reason
          : `${reason}. Dispatch is unconfirmed; do not re-dispatch. Group: ${pending.groupId}; result: ${pending.background.resultId}; collect: ${collectEnvelopeText(pending.groupId, pending.background.resultId)}`,
      );
    }
    if (event.isError) {
      if (pending.background === undefined) discardPendingBackground(pending);
      const nativeError = event.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n")
        .trim();
      const reason = nativeError.length > 0
        ? `native eval failed: ${nativeError.slice(0, 800)}`
        : "native eval failed before Task Group produced a result";
      return resultError(
        pending.background === undefined
          ? reason
          : `${reason}. Dispatch may have started; do not re-dispatch. Group: ${pending.groupId}; result: ${pending.background.resultId}; collect: ${collectEnvelopeText(pending.groupId, pending.background.resultId)}`,
      );
    }
    if (pending.background !== undefined) {
      let receipt;
      try {
        receipt = decodePoolBackgroundDispatch(event.details, {
          groupId: pending.groupId,
          resultId: pending.background.resultId,
          taskCount: pending.spec.tasks.length,
        });
      } catch (error) {
        // No verified push ids: never claim success. Keep the record so an
        // actual dispatch (if any) can still be collected; never re-dispatch.
        return resultError(
          `background dispatch was not confirmed: ${error instanceof Error ? error.message : String(error)}; do not re-dispatch. Group: ${pending.groupId}; result: ${pending.background.resultId}; collect: ${collectEnvelopeText(pending.groupId, pending.background.resultId)}`,
        );
      }
      if (receipt.state === "failed") {
        discardPendingBackground(pending);
        return dispatchFailurePatch(pending, receipt);
      }
      lastPlan = pending.plan;
      return dispatchedPatch(pending, pending.background, receipt);
    }

    try {
      const result = decodeEvalGroupResult(event.details, pending.spec, pending.groupId);
      const outcome = await finalizeDecodedGroup(pending, result);
      lastPlan = outcome.plan;
      return {
        content: [{ type: "text", text: outcome.text }],
        details: outcome.details,
        isError: outcome.isError,
      };
    } catch (error) {
      return resultError(
        `native eval completed without a valid Task Group eval result: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  // ── /task-group command ────────────────────────────────────────────
  registerTaskGroupCommand(pi, {
    getConfig: (ctx) => {
      try {
        return loadConfig(ctx.cwd);
      } catch {
        return fallbackConfig;
      }
    },
    getTelemetry: () => telemetry,
    getLastPlan: () => lastPlan,
    getCapabilities: (ctx) => {
      try {
        return probeCapabilities(ctx, loadConfig(ctx.cwd));
      } catch {
        return probeCapabilities(ctx, fallbackConfig);
      }
    },
  });
}

