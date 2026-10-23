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
  let summary: string | undefined;
  if (payload.summary !== undefined) {
    if (typeof payload.summary !== "string") fail("eval result payload summary must be a string");
    summary = payload.summary;
  }
  const summaryError = payload.summaryError;
  if (summaryError !== undefined && typeof summaryError !== "string") {
    fail("eval result payload summaryError must be a string");
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
  if (summary !== undefined) result.summary = summary;
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
    const detail = firstError.length <= 240 ? firstError : `${firstError.slice(0, 239)}…`;
    text += ` — ${detail}`;
  }
  return text;
}
