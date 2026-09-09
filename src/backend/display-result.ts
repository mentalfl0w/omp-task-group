/**
 * omp-task-group — native eval display-result decoder.
 *
 * Envelope finalization receives the COMPLETED native eval tool result. Its
 * details.jsonOutputs array holds the RAW values passed to the eval prelude's
 * display(); the compiled group program (src/compiler/program.ts) calls
 * display() exactly once with the protocol payload. This module is the
 * compiler's inverse: it locates that payload among any foreign display
 * values, validates it against the spec and the expected group id, and
 * produces the engine's GroupRunResult. It knows nothing about presentation
 * and never touches host internals.
 *
 * Fail-closed rules (never guess, never return partial success):
 *  - a truthy details.async (cell auto-backgrounded) is a barrier violation:
 *    the envelope tool_result handler reports it before decode; this module
 *    throws as a defensive backstop.
 *  - protocol + groupId must match EXACTLY; foreign display() values in the
 *    same kernel are tolerated but never mixed in.
 *  - outcome names must cover the spec's task names exactly once each;
 *    unknown names, unknown statuses and mistyped optional fields throw.
 *  - wire groupState is authoritative: "completed" is a clean result,
 *    "failed" yields a descriptive groupError when the wire omitted one,
 *    "cancelled" surfaces as GroupRunResult.cancelled (defensive — the
 *    compiler never emits group-level "cancelled" today).
 *  - explicit groupError/summary survive untouched. A summaryError without
 *    groupError folds into groupError ("summarizer failed: …") — the only
 *    GroupRunResult field able to carry it.
 */
import { DISPLAY_PROTOCOL } from "../compiler/program";
import type { GroupRunResult, TaskOutcome } from "./interface";
import type { TaskGroupSpec } from "../schema/task-group";
import { isRecord } from "../guards";

/** Thrown when an eval result cannot be decoded into a valid group result. */
export class DisplayResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DisplayResultError";
  }
}

/** Static membership tables (rule: Record over Set for literal keys). */
const TASK_STATUSES: Record<string, true> = { succeeded: true, failed: true, cancelled: true };
const GROUP_STATES: Record<string, true> = { completed: true, failed: true, cancelled: true };

function fail(message: string): never {
  throw new DisplayResultError(message);
}

/**
 * Decode a completed native eval result into a GroupRunResult.
 *
 * @param details        tool_result details from the native eval call
 *                       (details.jsonOutputs = raw display() values).
 * @param spec           the validated TaskGroupSpec the group ran under.
 * @param expectedGroupId group id the payload must be addressed to.
 */
export function decodeDisplayGroupResult(
  details: unknown,
  spec: TaskGroupSpec,
  expectedGroupId: string,
): GroupRunResult {
  if (!isRecord(details)) {
    fail(
      `eval result details are not an object (got ${details === null ? "null" : typeof details}); cannot read display output`,
    );
  }
  if (details.async) {
    fail(
      "eval cell auto-backgrounded (details.async set); strict foreground barrier unavailable — task-group result is not final",
    );
  }
  const jsonOutputs = details.jsonOutputs;
  if (!Array.isArray(jsonOutputs)) {
    fail(`eval result details.jsonOutputs is missing or not an array (got ${typeof jsonOutputs}); expected display() values`);
  }
  const payload = selectPayload(jsonOutputs, expectedGroupId);
  return decodePayload(payload, spec, expectedGroupId);
}

/** Find the single protocol payload for this group among foreign display values. */
function selectPayload(jsonOutputs: unknown[], expectedGroupId: string): Record<string, unknown> {
  let protocolCount = 0;
  let matchingCount = 0;
  let matched: Record<string, unknown> | undefined;
  const groupIds = new Set<string>();
  for (const entry of jsonOutputs) {
    if (!isRecord(entry) || entry.protocol !== DISPLAY_PROTOCOL) continue;
    protocolCount += 1;
    if (typeof entry.groupId === "string") groupIds.add(entry.groupId);
    if (entry.groupId === expectedGroupId) {
      matchingCount += 1;
      matched ??= entry;
    }
  }
  if (matchingCount === 1 && matched !== undefined) return matched;
  const foreignProtocols = [
    ...new Set(
      jsonOutputs.flatMap((entry) => (isRecord(entry) && typeof entry.protocol === "string" ? [entry.protocol] : [])),
    ),
  ];
  if (protocolCount === 0) {
    const seen =
      foreignProtocols.length > 0
        ? ` (display protocols seen: ${foreignProtocols.join(", ")})`
        : " (no protocol-bearing display values)";
    fail(
      `no ${DISPLAY_PROTOCOL} display payload for group ${JSON.stringify(expectedGroupId)} among ${jsonOutputs.length} eval display value(s)${seen}`,
    );
  }
  if (matchingCount > 1) {
    fail(
      `found ${matchingCount} ${DISPLAY_PROTOCOL} display payloads for group ${JSON.stringify(expectedGroupId)} (expected exactly one)`,
    );
  }
  fail(
    `found ${protocolCount} ${DISPLAY_PROTOCOL} display payload(s) but none for group ${JSON.stringify(expectedGroupId)} (group ids seen: ${groupIds.size > 0 ? [...groupIds].join(", ") : "(none)"})`,
  );
}

function decodePayload(
  payload: Record<string, unknown>,
  spec: TaskGroupSpec,
  expectedGroupId: string,
): GroupRunResult {
  const strategy = payload.strategy;
  if (strategy !== "fanout" && strategy !== "pool") {
    fail(`display payload strategy must be "fanout" | "pool" (got ${JSON.stringify(strategy)})`);
  }
  const groupState = payload.groupState;
  if (typeof groupState !== "string" || GROUP_STATES[groupState] !== true) {
    fail(`display payload groupState must be "completed" | "failed" | "cancelled" (got ${JSON.stringify(groupState)})`);
  }
  const rawChildChars = payload.rawChildChars;
  if (typeof rawChildChars !== "number" || !Number.isInteger(rawChildChars) || rawChildChars < 0) {
    fail(`display payload rawChildChars must be a non-negative integer (got ${JSON.stringify(rawChildChars)})`);
  }
  const outcomes = decodeOutcomes(payload.outcomes, spec);

  let groupError: string | undefined;
  if (payload.groupError !== undefined) {
    if (typeof payload.groupError !== "string") fail("display payload groupError must be a string");
    groupError = payload.groupError;
  }
  let summary: string | undefined;
  if (payload.summary !== undefined) {
    if (typeof payload.summary !== "string") fail("display payload summary must be a string");
    summary = payload.summary;
  }
  const summaryError = payload.summaryError;
  if (summaryError !== undefined && typeof summaryError !== "string") {
    fail("display payload summaryError must be a string");
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
    fail("display payload outcomes must be a non-empty array");
  }
  const expectedNames = spec.tasks.map((task) => task.name);
  const expectedAgents = new Map(spec.tasks.map((task) => [task.name, task.agent]));
  const expectedSet = new Set(expectedNames);
  const counts = new Map<string, number>();
  const outcomes: TaskOutcome[] = [];
  rawOutcomes.forEach((raw, i) => {
    const ctx = `display payload outcomes[${i}]`;
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
      fail(`display payload is missing an outcome for task ${JSON.stringify(name)} (refusing partial success)`);
    }
    if (count > 1) {
      fail(`display payload has ${count} outcomes for task ${JSON.stringify(name)} (expected exactly one)`);
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
