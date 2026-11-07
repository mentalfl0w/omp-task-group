/**
 * omp-task-group — native eval result decoder.
 *
 * OMP JS eval exposes `console.log()` and stores JSON views in
 * details.cells[].views[].view.value. The compiler emits bounded chunks with
 * an exact protocol and group id; this module reassembles and validates the
 * wire payload before it reaches the Task Group engine.
 *
 * Fail closed: reject backgrounded cells, missing/foreign/duplicate chunks,
 * malformed JSON, and task sets that do not exactly match the requested spec.
 */
import {
  EVAL_RESULT_CHUNK_CHARS,
  EVAL_RESULT_MAX_CHUNKS,
  EVAL_RESULT_PROTOCOL,
  EVAL_RESULT_TRANSPORT,
  POOL_BACKGROUND_COLLECT_TRANSPORT,
  POOL_BACKGROUND_DISPATCH_TRANSPORT,
} from "../compiler/program";
import type { GroupRunResult, TaskOutcome } from "./interface";
import type { TaskGroupSpec } from "../schema/task-group";
import { isRecord } from "../guards";

/** Thrown when an eval result cannot be decoded into a valid group result. */
export class EvalResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalResultError";
  }
}

/** Static membership tables (rule: Record over Set for literal keys). */
const TASK_STATUSES: Record<string, true> = { succeeded: true, failed: true, cancelled: true };
const GROUP_STATES: Record<string, true> = { completed: true, failed: true, cancelled: true };

function fail(message: string): never {
  throw new EvalResultError(message);
}

/**
 * Decode a completed native eval result into a GroupRunResult.
 *
 * @param details         tool_result details from native eval
 * @param spec            the validated TaskGroupSpec the group ran under
 * @param expectedGroupId group id the payload must be addressed to
 */
export function decodeEvalGroupResult(
  details: unknown,
  spec: TaskGroupSpec,
  expectedGroupId: string,
): GroupRunResult {
  if (!isRecord(details)) {
    fail(`eval result details are not an object (got ${details === null ? "null" : typeof details})`);
  }
  if (details.async) {
    fail("eval cell auto-backgrounded (details.async set); Task Group requires a foreground result");
  }
  if (!Array.isArray(details.cells)) {
    fail(`eval result details.cells is missing or not an array (got ${typeof details.cells})`);
  }
  const payload = selectResultPayload(details.cells, expectedGroupId);
  return decodePayload(payload, spec, expectedGroupId);
}

function selectResultPayload(cells: unknown[], expectedGroupId: string): Record<string, unknown> {
  const { chunks, groupIds } = collectResultChunks(cells, expectedGroupId);
  if (chunks.length === 0) {
    fail(
      `no ${EVAL_RESULT_PROTOCOL} JSON view for group ${JSON.stringify(expectedGroupId)} (group ids seen: ${groupIds.size > 0 ? [...groupIds].join(", ") : "(none)"})`,
    );
  }
  return parseResultPayload(reassembleResultChunks(chunks), expectedGroupId);
}

/**
 * Decode an already-parsed wire payload (the background result file embeds
 * exactly this object). Uses the same validation and exact-coverage rules as
 * the foreground view transport.
 */
export function decodeEvalPayload(
  payload: unknown,
  spec: TaskGroupSpec,
  expectedGroupId: string,
): GroupRunResult {
  if (!isRecord(payload)) fail("eval payload must be an object");
  return decodePayload(payload, spec, expectedGroupId);
}

function collectResultChunks(
  cells: unknown[],
  expectedGroupId: string,
): { chunks: Record<string, unknown>[]; groupIds: Set<string> } {
  const chunks: Record<string, unknown>[] = [];
  const groupIds = new Set<string>();
  for (const cell of cells) {
    if (!isRecord(cell) || !Array.isArray(cell.views)) continue;
    for (const entry of cell.views) {
      if (!isRecord(entry) || !isRecord(entry.view) || entry.view.kind !== "json" || !isRecord(entry.view.value)) {
        continue;
      }
      const value = entry.view.value;
      if (value.protocol !== EVAL_RESULT_PROTOCOL || value.transport !== EVAL_RESULT_TRANSPORT) continue;
      if (typeof value.groupId === "string") groupIds.add(value.groupId);
      if (value.groupId === expectedGroupId) chunks.push(value);
    }
  }
  return { chunks, groupIds };
}

function reassembleResultChunks(chunks: Record<string, unknown>[]): string {
  let overflow: Record<string, unknown> | undefined;
  for (const chunk of chunks) {
    if (chunk.overflow === true) {
      overflow = chunk;
      break;
    }
  }
  if (overflow !== undefined) {
    const required =
      typeof overflow.chunkCount === "number" ? overflow.chunkCount : "more than the supported limit";
    fail(
      `Task Group result exceeds OMP's structured-view capacity (${required} chunks required; maximum ${EVAL_RESULT_MAX_CHUNKS})`,
    );
  }

  const chunkCount = chunks[0]?.chunkCount;
  if (typeof chunkCount !== "number" || !Number.isInteger(chunkCount) || chunkCount < 1) {
    fail(`eval result chunkCount must be a positive integer (got ${JSON.stringify(chunkCount)})`);
  }
  if (chunkCount > EVAL_RESULT_MAX_CHUNKS) {
    fail(`eval result requires ${chunkCount} JSON views; OMP retains at most ${EVAL_RESULT_MAX_CHUNKS} per cell`);
  }
  if (chunks.length !== chunkCount) {
    fail(`found ${chunks.length} eval result view chunk(s); expected ${chunkCount}`);
  }

  const parts: Array<string | undefined> = new Array(chunkCount);
  for (const chunk of chunks) {
    if (chunk.chunkCount !== chunkCount) fail("eval result view chunks disagree on chunkCount");
    const index = chunk.chunkIndex;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= chunkCount) {
      fail(`eval result chunkIndex is outside [0, ${chunkCount - 1}] (got ${JSON.stringify(index)})`);
    }
    if (typeof chunk.data !== "string") fail(`eval result chunk ${index} data must be a string`);
    if (chunk.data.length > EVAL_RESULT_CHUNK_CHARS) {
      fail(`eval result chunk ${index} exceeds ${EVAL_RESULT_CHUNK_CHARS} characters`);
    }
    if (parts[index] !== undefined) fail(`duplicate eval result view chunk at index ${index}`);
    parts[index] = chunk.data;
  }
  for (const part of parts) {
    if (part === undefined) fail("eval result view chunks are incomplete");
  }
  return parts.join("");
}

function parseResultPayload(serialized: string, expectedGroupId: string): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(serialized);
  } catch {
    fail("eval result view chunks do not contain valid JSON");
  }
  if (!isRecord(payload)) fail("eval result payload must be an object");
  if (payload.protocol !== EVAL_RESULT_PROTOCOL) {
    fail(`eval result payload protocol must be ${JSON.stringify(EVAL_RESULT_PROTOCOL)}`);
  }
  if (payload.groupId !== expectedGroupId) {
    fail(`eval result payload groupId must equal ${JSON.stringify(expectedGroupId)}`);
  }
  return payload;
}

function decodePayload(
  payload: Record<string, unknown>,
  spec: TaskGroupSpec,
  expectedGroupId: string,
): GroupRunResult {
  const strategy = payload.strategy;
  if (strategy !== "fanout" && strategy !== "pool") {
    fail(`eval result payload strategy must be "fanout" | "pool" (got ${JSON.stringify(strategy)})`);
  }
  const groupState = payload.groupState;
  if (typeof groupState !== "string" || GROUP_STATES[groupState] !== true) {
    fail(`eval result payload groupState must be "completed" | "failed" | "cancelled" (got ${JSON.stringify(groupState)})`);
  }
  const rawChildChars = payload.rawChildChars;
  if (typeof rawChildChars !== "number" || !Number.isInteger(rawChildChars) || rawChildChars < 0) {
    fail(`eval result payload rawChildChars must be a non-negative integer (got ${JSON.stringify(rawChildChars)})`);
  }
  const outcomes = decodeOutcomes(payload.outcomes, spec);

  let groupError: string | undefined;
  if (payload.groupError !== undefined) {
    if (typeof payload.groupError !== "string") fail("eval result payload groupError must be a string");
    groupError = payload.groupError;
  }
  let fallbackReason: string | undefined;
  if (payload.fallbackReason !== undefined) {
    if (typeof payload.fallbackReason !== "string") fail("eval result payload fallbackReason must be a string");
    fallbackReason = payload.fallbackReason;
  }
  let summary: string | undefined;
  if (payload.summary !== undefined) {
    if (typeof payload.summary !== "string") fail("eval result payload summary must be a string");
    summary = payload.summary;
  }
  const summaryError = payload.summaryError;
  if (summaryError !== undefined && typeof summaryError !== "string") {
    fail("eval result payload summaryError must be a string");
  }

  let gateText: string | undefined;
  let gateMode: GroupRunResult["gateMode"];
  let gateDeliveredChars: number | undefined;
  let gateError: string | undefined;
  if (
    payload.gateText !== undefined ||
    payload.gateMode !== undefined ||
    payload.gatedChars !== undefined ||
    payload.gateError !== undefined
  ) {
    if (typeof payload.gateText !== "string") {
      fail("eval result payload gateText must be a string when gate fields are present");
    }
    if (payload.gateMode !== "compact" && payload.gateMode !== "structured" && payload.gateMode !== "summarize") {
      fail('eval result payload gateMode must be "compact" | "structured" | "summarize"');
    }
    if (
      typeof payload.gatedChars !== "number" ||
      !Number.isInteger(payload.gatedChars) ||
      payload.gatedChars !== payload.gateText.length
    ) {
      fail("eval result payload gatedChars must equal gateText.length");
    }
    if (payload.gateText.length > spec.output.maxTotalChars) {
      fail(
        `eval result payload gateText is ${payload.gateText.length} characters; maxTotalChars is ${spec.output.maxTotalChars}`,
      );
    }
    if (payload.gateError !== undefined) {
      if (typeof payload.gateError !== "string" || payload.gateError.length === 0) {
        fail("eval result payload gateError must be a non-empty string");
      }
      gateError = payload.gateError;
    }
    gateText = payload.gateText;
    gateMode = payload.gateMode;
    gateDeliveredChars = payload.gatedChars;
  }

  // Wire groupState is authoritative: a "failed" group with no explicit
  // groupError still yields a descriptive one (the runner derives failure
  // from groupError !== undefined). A summaryError folds in only when no
  // group-level error is already present.
  if (groupState === "failed" && groupError === undefined) {
    groupError = describeGroupFailure(outcomes);
  }
  if (groupError === undefined && summaryError !== undefined) {
    groupError = `summarizer failed: ${summaryError}`;
  }

  const result: GroupRunResult = {
    groupId: expectedGroupId,
    strategy,
    outcomes,
    rawChildChars,
  };
  if (groupError !== undefined) result.groupError = groupError;
  if (fallbackReason !== undefined) result.fallbackReason = fallbackReason;
  if (summary !== undefined) result.summary = summary;
  if (gateText !== undefined && gateMode !== undefined && gateDeliveredChars !== undefined) {
    result.gateText = gateText;
    result.gateMode = gateMode;
    result.gateDeliveredChars = gateDeliveredChars;
  }
  if (gateError !== undefined) {
    if (result.gateText === undefined || result.gateMode === undefined) {
      fail("eval result payload gateError requires gateText and gateMode");
    }
    result.gateError = gateError;
  }
  if (groupState === "cancelled") result.cancelled = true;
  return result;
}

function decodeOutcomes(rawOutcomes: unknown, spec: TaskGroupSpec): TaskOutcome[] {
  if (!Array.isArray(rawOutcomes) || rawOutcomes.length === 0) {
    fail("eval result payload outcomes must be a non-empty array");
  }
  const expectedNames = spec.tasks.map((task) => task.name);
  const expectedAgents = new Map(spec.tasks.map((task) => [task.name, task.agent]));
  const expectedSet = new Set(expectedNames);
  const counts = new Map<string, number>();
  const outcomes: TaskOutcome[] = [];
  rawOutcomes.forEach((raw, i) => {
    const ctx = `eval result payload outcomes[${i}]`;
    if (!isRecord(raw)) fail(`${ctx} must be an object`);
    const name = raw.name;
    if (typeof name !== "string" || name.length === 0) {
      fail(`${ctx}.name must be a non-empty string (got ${JSON.stringify(name)})`);
    }
    if (!expectedSet.has(name)) {
      fail(`${ctx} names unknown task ${JSON.stringify(name)} (expected one of: ${expectedNames.join(", ")})`);
    }
    counts.set(name, (counts.get(name) ?? 0) + 1);

    const agent = raw.agent;
    if (typeof agent !== "string" || agent.length === 0) {
      fail(`${ctx} (${name}).agent must be a non-empty string (got ${JSON.stringify(agent)})`);
    }
    const expectedAgent = expectedAgents.get(name);
    if (agent !== expectedAgent) {
      fail(`${ctx} (${name}).agent must equal the requested task agent ${JSON.stringify(expectedAgent)}`);
    }
    const status = raw.status;
    if (typeof status !== "string" || TASK_STATUSES[status] !== true) {
      fail(`${ctx} (${name}) has unknown status ${JSON.stringify(status)} (expected "succeeded" | "failed" | "cancelled")`);
    }

    const entry: TaskOutcome = { name, agent, status: status as TaskOutcome["status"] };
    if (raw.handle !== undefined) {
      if (typeof raw.handle !== "string") fail(`${ctx} (${name}).handle must be a string`);
      entry.handle = raw.handle;
    }
    if (raw.durationMs !== undefined) {
      if (typeof raw.durationMs !== "number" || !Number.isFinite(raw.durationMs) || raw.durationMs < 0) {
        fail(`${ctx} (${name}).durationMs must be a non-negative number`);
      }
      entry.durationMs = raw.durationMs;
    }
    if (raw.resolvedModel !== undefined) {
      if (typeof raw.resolvedModel !== "string") fail(`${ctx} (${name}).resolvedModel must be a string`);
      entry.resolvedModel = raw.resolvedModel;
    }
    if (raw.result !== undefined) {
      if (typeof raw.result !== "string") fail(`${ctx} (${name}).result must be a string`);
      entry.result = raw.result;
    }
    // structured is an untyped JSON value — null / 0 / false / "" are real
    // child outputs and MUST survive; presence (own property) decides.
    if (Object.prototype.hasOwnProperty.call(raw, "structured")) entry.structured = raw.structured;
    if (raw.error !== undefined) {
      if (typeof raw.error !== "string") fail(`${ctx} (${name}).error must be a string`);
      entry.error = raw.error;
    }
    outcomes.push(entry);
  });

  // Exact coverage: every spec task appears exactly once — never partial.
  for (const name of expectedNames) {
    const count = counts.get(name);
    if (count === undefined) {
      fail(`eval result payload is missing an outcome for task ${JSON.stringify(name)} (refusing partial success)`);
    }
    if (count > 1) {
      fail(`eval result payload has ${count} outcomes for task ${JSON.stringify(name)} (expected exactly one)`);
    }
  }
  return outcomes;
}

/** Describe a wire-level group failure from the decoded outcomes. */
function describeGroupFailure(outcomes: TaskOutcome[]): string {
  const failed = outcomes.filter((o) => o.status === "failed").length;
  const cancelled = outcomes.filter((o) => o.status === "cancelled").length;
  const total = outcomes.length;
  if (failed === 0 && cancelled === 0) {
    return `group failed: join condition unmet — all ${total} task(s) settled with no recorded failure`;
  }
  let text = `group failed: ${failed}/${total} task(s) failed`;
  if (cancelled > 0) text += `, ${cancelled} cancelled`;
  const firstError = outcomes.find((o) => o.error !== undefined && o.error.length > 0)?.error;
  if (firstError !== undefined) {
    let end = 239;
    const last = firstError.charCodeAt(end - 1);
    const next = firstError.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
    const detail = firstError.length <= 240 ? firstError : `${firstError.slice(0, end)}…`;
    text += ` — ${detail}`;
  }
  return text;
}

// ── Two-phase Workpool background receipts ───────────────────────────

export interface BackgroundPoolFacts {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  closed: boolean;
  pending: number;
  batches: number;
}

export interface BackgroundOutcomeCounts {
  succeeded: number;
  failed: number;
  cancelled: number;
}

export interface PoolBackgroundDispatchReceipt {
  state: "dispatched";
  groupId: string;
  resultId: string;
  poolName: string;
  itemIds: string[];
  taskCount: number;
}

export interface PoolBackgroundDispatchFailure {
  state: "failed";
  groupId: string;
  resultId: string;
  stage: string;
  reason: string;
  dispatched: boolean;
  cancelled?: boolean;
  cancelError?: string;
}

export type PoolBackgroundDispatchResult = PoolBackgroundDispatchReceipt | PoolBackgroundDispatchFailure;

export interface PoolBackgroundCollectReceipt {
  state: "pending" | "ready" | "failed";
  groupId: string;
  resultId: string;
  stage?: string;
  reason?: string;
  counts?: BackgroundOutcomeCounts;
  pool?: BackgroundPoolFacts;
  groupState?: "completed" | "failed" | "cancelled";
  path?: string;
  checksum?: string;
  payloadChars?: number;
}

/**
 * Select exactly one background receipt JSON view. Missing, duplicate,
 * foreign, or auto-backgrounded cells are explicit protocol failures.
 */
function selectBackgroundReceipt(
  details: unknown,
  transport: string,
  expectedGroupId: string,
  expectedResultId: string,
): Record<string, unknown> {
  if (!isRecord(details)) fail("eval result details are not an object");
  if (details.async) {
    fail("native eval auto-backgrounded the background control cell; its in-cell receipt cannot be trusted and it is not a result");
  }
  if (!Array.isArray(details.cells)) {
    fail("eval result details.cells is missing or not an array");
  }
  const matches: Record<string, unknown>[] = [];
  for (const cell of details.cells) {
    if (!isRecord(cell) || !Array.isArray(cell.views)) continue;
    for (const entry of cell.views) {
      if (!isRecord(entry) || !isRecord(entry.view) || entry.view.kind !== "json" || !isRecord(entry.view.value)) {
        continue;
      }
      const value = entry.view.value;
      if (value.protocol !== EVAL_RESULT_PROTOCOL || value.transport !== transport) continue;
      if (value.groupId !== expectedGroupId) {
        fail("background control receipt belongs to a different group");
      }
      if (value.resultId !== expectedResultId) {
        fail("background control receipt belongs to a different result id");
      }
      matches.push(value);
    }
  }
  if (matches.length === 0) {
    fail(`no ${transport} JSON view for background group ${JSON.stringify(expectedGroupId)}`);
  }
  if (matches.length > 1) {
    fail(`found ${matches.length} ${transport} JSON views; expected exactly one`);
  }
  return matches[0] as Record<string, unknown>;
}

function countField(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(`${what} must be a non-negative integer`);
  }
  return value;
}

function decodeBackgroundCounts(raw: unknown, what: string): BackgroundOutcomeCounts {
  if (!isRecord(raw)) fail(`${what} must be an object`);
  return {
    succeeded: countField(raw.succeeded, `${what}.succeeded`),
    failed: countField(raw.failed, `${what}.failed`),
    cancelled: countField(raw.cancelled, `${what}.cancelled`),
  };
}

function decodeBackgroundPoolFacts(raw: unknown): BackgroundPoolFacts | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) fail("background pool facts must be an object");
  if (typeof raw.closed !== "boolean") fail("background pool facts closed must be a boolean");
  return {
    queued: countField(raw.queued, "background pool queued"),
    running: countField(raw.running, "background pool running"),
    completed: countField(raw.completed, "background pool completed"),
    failed: countField(raw.failed, "background pool failed"),
    cancelled: countField(raw.cancelled, "background pool cancelled"),
    closed: raw.closed,
    pending: countField(raw.pending, "background pool pending"),
    batches: countField(raw.batches, "background pool batches"),
  };
}

/** Decode the dispatch cell receipt. Success requires the verified push ids. */
export function decodePoolBackgroundDispatch(
  details: unknown,
  expected: { groupId: string; resultId: string; taskCount: number },
): PoolBackgroundDispatchResult {
  const value = selectBackgroundReceipt(
    details,
    POOL_BACKGROUND_DISPATCH_TRANSPORT,
    expected.groupId,
    expected.resultId,
  );
  if (value.state === "failed") {
    if (typeof value.stage !== "string" || value.stage.length === 0) {
      fail("background dispatch failure stage must be a non-empty string");
    }
    if (typeof value.reason !== "string" || value.reason.length === 0) {
      fail("background dispatch failure reason must be a non-empty string");
    }
    if (typeof value.dispatched !== "boolean") {
      fail("background dispatch failure dispatched flag must be a boolean");
    }
    if (value.cancelled !== undefined && typeof value.cancelled !== "boolean") {
      fail("background dispatch failure cancelled flag must be a boolean");
    }
    if (value.cancelError !== undefined && typeof value.cancelError !== "string") {
      fail("background dispatch failure cancelError must be a string");
    }
    return {
      state: "failed",
      groupId: expected.groupId,
      resultId: expected.resultId,
      stage: value.stage,
      reason: value.reason,
      dispatched: value.dispatched,
      ...(value.cancelled !== undefined ? { cancelled: value.cancelled } : {}),
      ...(value.cancelError !== undefined ? { cancelError: value.cancelError } : {}),
    };
  }
  if (value.state !== "dispatched") {
    fail(`background dispatch receipt state must be "dispatched" | "failed"`);
  }
  if (value.poolName !== expected.groupId) {
    fail("background dispatch receipt poolName must equal the group id");
  }
  const taskCount = countField(value.taskCount, "background dispatch taskCount");
  if (taskCount !== expected.taskCount) {
    fail(`background dispatch receipt covers ${taskCount} task(s); expected ${expected.taskCount}`);
  }
  if (!Array.isArray(value.itemIds) || value.itemIds.length !== taskCount) {
    fail("background dispatch receipt must carry exactly one item id per task");
  }
  const itemIds: string[] = [];
  for (const id of value.itemIds) {
    if (typeof id !== "string" || id.length === 0) fail("background dispatch item ids must be non-empty strings");
    itemIds.push(id);
  }
  if (new Set(itemIds).size !== itemIds.length) {
    fail("background dispatch item ids must be unique");
  }
  return {
    state: "dispatched",
    groupId: expected.groupId,
    resultId: expected.resultId,
    poolName: expected.groupId,
    itemIds,
    taskCount,
  };
}

/** Decode the collect cell receipt. `state` is authoritative. */
export function decodePoolBackgroundCollect(
  details: unknown,
  expected: { groupId: string; resultId: string; path: string },
): PoolBackgroundCollectReceipt {
  const value = selectBackgroundReceipt(
    details,
    POOL_BACKGROUND_COLLECT_TRANSPORT,
    expected.groupId,
    expected.resultId,
  );
  const state = value.state;
  if (state !== "pending" && state !== "ready" && state !== "failed") {
    fail(`background collect receipt state must be "pending" | "ready" | "failed"`);
  }
  const pool = decodeBackgroundPoolFacts(value.pool);
  const counts = value.counts === undefined ? undefined : decodeBackgroundCounts(value.counts, "background collect counts");
  if (state === "pending") {
    if (value.reason !== undefined && (typeof value.reason !== "string" || value.reason.length === 0)) {
      fail("background collect pending reason must be a non-empty string");
    }
    return {
      state,
      groupId: expected.groupId,
      resultId: expected.resultId,
      ...(counts !== undefined ? { counts } : {}),
      ...(pool !== undefined ? { pool } : {}),
      ...(value.reason !== undefined ? { reason: value.reason as string } : {}),
    };
  }
  if (state === "failed") {
    if (typeof value.stage !== "string" || value.stage.length === 0) {
      fail("background collect failure stage must be a non-empty string");
    }
    if (typeof value.reason !== "string" || value.reason.length === 0) {
      fail("background collect failure reason must be a non-empty string");
    }
    return {
      state,
      groupId: expected.groupId,
      resultId: expected.resultId,
      stage: value.stage,
      reason: value.reason,
      ...(counts !== undefined ? { counts } : {}),
      ...(pool !== undefined ? { pool } : {}),
    };
  }
  const groupState = value.groupState;
  if (groupState !== "completed" && groupState !== "failed" && groupState !== "cancelled") {
    fail(`background collect groupState must be "completed" | "failed" | "cancelled"`);
  }
  if (value.path !== expected.path) {
    fail("background collect receipt path does not match the registered result path");
  }
  if (counts === undefined) fail("background collect ready receipt must carry outcome counts");
  if (typeof value.checksum !== "string" || !/^[a-f0-9]{64}$/.test(value.checksum)) {
    fail("background collect checksum must be a 64-character lowercase hex digest");
  }
  const payloadChars = countField(value.payloadChars, "background collect payloadChars");
  return {
    state,
    groupId: expected.groupId,
    resultId: expected.resultId,
    groupState,
    counts,
    ...(pool !== undefined ? { pool } : {}),
    path: value.path,
    checksum: value.checksum,
    payloadChars,
  };
}
