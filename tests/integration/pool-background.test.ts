/**
 * omp-task-group — LIVE background Workpool integration tests (P0).
 *
 * These tests exercise the two-phase background Workpool contract with a REAL
 * headless OMP run (`omp -p --wait-async`). `eval.autoBackground` is pinned to
 * `enabled=false` on purpose: dispatch must not depend on the host converting
 * a blocking Eval cell into an async job. The native Workpool itself keeps the
 * workers and its aggregate job alive after the dispatch cell returns.
 *
 * Contract under test (all evidence comes from the persisted session JSONL):
 *
 *   1. `ompTaskGroup({... background:"require"})` compiles to a dispatch-only
 *      Eval cell. It creates a Workpool, pushes every homogeneous all+collect
 *      item, stores the pool handle, and returns synchronously with a dispatch
 *      receipt (`delivery:"workpool-async"`, `state:"dispatched"`, real
 *      `itemIds`, `taskCount`, `collect` envelope, private `path`). No
 *      `details.async` and no result file are produced here.
 *   2. The main agent keeps working (creates a marker) while the child items
 *      run. Each child touches a started sentinel and briefly sleeps before
 *      quoting its random nonce — the marker write and the later notice prove
 *      the parent continuation without depending on any particular tool order.
 *   3. OMP delivers EXACTLY ONE native `async-result` aggregate message per
 *      pool (type `task`, jobId = pool name = groupId). This native notice is
 *      not the gated Task Group result.
 *   4. After the notice the model sends the strict collect envelope
 *      `ompTaskGroupCollect({"groupId":"…","resultId":"tgbg_…"})`. Collect
 *      reattaches the retained pool handle, verifies exact item/batch coverage,
 *      runs the shared Result Gate, and stores the bounded payload through the
 *      write-approved `task_group_store_result` tool. The collect cell itself
 *      performs no filesystem I/O. A still-running pool reports
 *      `state:"pending"`; collect never waits and never consumes another job.
 *   5. `task_group_result` reads the gated text in bounded segments until
 *      `complete=true`, then `consume` deletes the private file. A repeated
 *      consume is a non-error receipt.
 *
 * Extra cases:
 *   - two pools dispatched concurrently: each produces exactly one aggregate
 *     notice, each collect/read is isolated by groupId+resultId, and neither
 *     gated result contains the other pool's tokens;
 *   - cancellation: `write proc://<groupId>/kill` cancels a running pool; the
 *     terminal collect reports a drained `cancelled` group (or fails closed if
 *     the handle is gone), never a fabricated success, and the gated text has
 *     no `✓` and no child token.
 *
 * OMP may expose extension tools through the public `write xd://<tool>`
 * device. The session parser normalizes `write xd://task_group_result` back to
 * a logical `task_group_result` call and unwraps `details.xdev.inner`, so
 * direct and routed exposure are both accepted.
 *
 * Isolation: the effective `eval.autoBackground.enabled=false` (plus async,
 * bash auto-background, approvals, and the Task Group pool threshold) comes
 * from a temporary project `.omp/config.yml` and `.omp/task-group.json` plus a
 * temporary `--config` overlay. These outrank user globals; the test never
 * reads or mutates user settings.
 *
 * Gated behind `TEST_INTEGRATION=1`; a built `dist/index.js` with the
 * two-phase Workpool wiring is required. Set `TEST_MODEL` to pin the parent
 * and child model:
 *
 *   bun run build && TEST_INTEGRATION=1 \
 *     TEST_MODEL=opencode-go/deepseek-v4.1-flash \
 *     bun test tests/integration/pool-background.test.ts
 *
 * On failure the session directory and workspace are kept, and a
 * `diagnostics.txt` (OMP output tails, every tool call/result pair, all async
 * notices, and the raw session messages) is written inside the session
 * directory. Set `KEEP_POOL_BACKGROUND_ARTIFACTS=1` to keep a successful run.
 *
 * The dispatch/collect envelopes and detail shapes above were synchronized
 * with the implementation owner (PoolBackground) before these assertions were
 * written; no mock or private API is used.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

const PLUGIN_ROOT = join(import.meta.dir, "..", "..");
const OURS_DIST = join(PLUGIN_ROOT, "dist", "index.js");

const RESULT_ID_PATTERN = /^tgbg_[a-f0-9]{16}$/;
const GROUP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SMART_APPROVE_EXTENSION = process.env.SMART_APPROVE_EXTENSION;
const RESULT_DIR_PATTERN = /^omp-task-group-results-/;

const TOKEN_A = "工作池甲令牌-6D1E";
const TOKEN_B = "工作池乙令牌-3F8C";
const TOKEN_C = "工作池丙令牌-2A7B";
const TOKEN_D = "工作池丁令牌-9E4F";
const TOKEN_E = "工作池戊令牌-1B6C";
const TOKEN_F = "工作池己令牌-8D2A";
const CANCELLED_TOKENS = ["取消甲令牌-5C7D", "取消乙令牌-0E9F", "取消丙令牌-4A1B"];

type Json = Record<string, unknown>;

interface SessionEntry {
  type?: string;
  customType?: string;
  content?: unknown;
  details?: unknown;
  message?: {
    role?: string;
    content?: unknown;
    toolCallId?: string;
    details?: unknown;
    isError?: boolean;
  };
}

interface ToolCall {
  entry: SessionEntry;
  id: string;
  name: string;
  args: Json;
}

interface ToolResult {
  entry: SessionEntry;
  callId?: string;
  text: string;
  details?: unknown;
  isError: boolean;
}

interface EvalOutcome {
  call: ToolCall;
  result: ToolResult;
  details?: Json;
  background?: Json;
}

interface DispatchInfo {
  groupId: string;
  resultId: string;
  itemIds: string[];
  path: string;
  eval: EvalOutcome;
}

interface ReadyCollectInfo {
  eval: EvalOutcome;
  background: Json;
  path: string;
  checksum: string;
  payloadChars: number;
}

interface ReadDelivery {
  delivered: string;
  checksum: string;
  payloadChars: number;
  total: number;
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function required<T>(value: T | undefined | null, label: string): T {
  if (value === undefined || value === null) throw new Error(`missing ${label}`);
  return value;
}

function recordOf(value: unknown, label: string): Json {
  expect(isRecord(value), `${label} must be an object`).toBe(true);
  return value as Json;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

function textOfEntry(entry: SessionEntry): string {
  return textOfContent(entry.message?.content ?? entry.content);
}

function loadEntries(sessionDir: string): SessionEntry[] {
  const files = readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl"));
  expect(files.length, `expected one main session file in ${sessionDir}`).toBe(1);
  const raw = readFileSync(join(sessionDir, files[0] as string), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SessionEntry);
}

/**
 * OMP may route an extension tool call through the public `write xd://<tool>`
 * device. Normalize that persisted call back to the logical tool contract.
 */
function normalizeToolCall(name: string, args: Json): { name: string; args: Json } {
  if (name !== "write") return { name, args };
  const path = typeof args.path === "string" ? args.path : "";
  if (!path.startsWith("xd://task_group_result")) return { name, args };
  let content: unknown = args.content;
  if (typeof content === "string") {
    try {
      content = JSON.parse(content);
    } catch {
      return { name, args };
    }
  }
  if (!isRecord(content) || typeof content.action !== "string" || typeof content.id !== "string") {
    return { name, args };
  }
  return { name: "task_group_result", args: content };
}

/**
 * The routed device result nests the extension tool result under
 * `details.xdev.inner`. Unwrap it so read/consume assertions see the same
 * shape as a direct extension tool call.
 */
function unwrapXdevDetails(details: unknown): unknown {
  if (isRecord(details) && isRecord(details.xdev) && details.xdev.inner !== undefined) {
    return details.xdev.inner;
  }
  return details;
}

function toolCallsOf(entries: SessionEntry[]): ToolCall[] {
  const out: ToolCall[] = [];
  for (const entry of entries) {
    const message = entry.message;
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "toolCall") continue;
      const id = typeof block.id === "string" ? block.id : undefined;
      const name = typeof block.name === "string" ? block.name : undefined;
      const args = isRecord(block.arguments) ? block.arguments : isRecord(block.args) ? block.args : undefined;
      if (id === undefined || name === undefined || args === undefined) continue;
      const normalized = normalizeToolCall(name, args);
      out.push({ entry, id, name: normalized.name, args: normalized.args });
    }
  }
  return out;
}

function toolResultsOf(entries: SessionEntry[]): ToolResult[] {
  const out: ToolResult[] = [];
  for (const entry of entries) {
    const message = entry.message;
    if (!message || message.role !== "toolResult") continue;
    out.push({
      entry,
      callId: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
      text: textOfContent(message.content),
      details: unwrapXdevDetails(message.details),
      isError: message.isError === true,
    });
  }
  return out;
}

function resultsByCallId(entries: SessionEntry[]): Map<string, ToolResult> {
  const out = new Map<string, ToolResult>();
  for (const result of toolResultsOf(entries)) {
    if (result.callId !== undefined) out.set(result.callId, result);
  }
  return out;
}
function taskGroupResultIdFromValue(value: Json): string | undefined {
  if (!isRecord(value.details)) return undefined;
  const background = value.details.background;
  if (isRecord(background) && typeof background.resultId === "string") return background.resultId;
  return typeof value.details.resultId === "string" ? value.details.resultId : undefined;
}

/**
 * Eval's public `tool.*` bridge can invoke task_group_result inside a JS cell.
 * OMP records that as one outer eval call; the returned tool result is retained
 * in the cell's structured JSON view, not as a top-level toolResult entry.
 * Promote only the verified structured result so the same integrity and
 * deletion assertions cover direct, xd://, and Eval-bridge routes.
 */
function expandEvalTaskGroupResultCalls(
  entries: SessionEntry[],
  calls: ToolCall[],
  results: Map<string, ToolResult>,
): void {
  const invocation = /\bawait\s+tool\.task_group_result\s*\(\s*(\{[^)]*\})\s*\)/g;
  for (const evalCall of calls.filter((call) => call.name === "eval")) {
    const code = typeof evalCall.args.code === "string" ? evalCall.args.code : "";
    const evalResult = results.get(evalCall.id);
    if (evalResult === undefined || !isRecord(evalResult.details)) continue;
    const cells = evalResult.details.cells;
    if (!Array.isArray(cells)) continue;
    let invocationIndex = 0;
    for (const match of code.matchAll(invocation)) {
      let args: unknown;
      try {
        args = JSON.parse(match[1] ?? "");
      } catch {
        continue;
      }
      if (
        !isRecord(args) ||
        typeof args.action !== "string" ||
        typeof args.id !== "string"
      ) {
        continue;
      }
      let returned: Json | undefined;
      for (const cell of cells) {
        if (!isRecord(cell) || !Array.isArray(cell.views)) continue;
        for (const viewEntry of cell.views) {
          if (
            !isRecord(viewEntry) ||
            !isRecord(viewEntry.view) ||
            viewEntry.view.kind !== "json" ||
            !isRecord(viewEntry.view.value)
          ) {
            continue;
          }
          const candidate = viewEntry.view.value;
          if (taskGroupResultIdFromValue(candidate) === args.id) {
            returned = candidate;
            break;
          }
        }
        if (returned !== undefined) break;
      }
      if (returned === undefined || !isRecord(returned.details)) continue;
      const id = `${evalCall.id}::task_group_result::${invocationIndex++}`;
      const nestedCall: ToolCall = {
        entry: evalCall.entry,
        id,
        name: "task_group_result",
        args,
      };
      calls.push(nestedCall);
      results.set(id, {
        entry: evalResult.entry,
        callId: id,
        text: typeof returned.text === "string" ? returned.text : textOfContent(returned.content),
        details: returned.details,
        isError: returned.isError === true,
      });
    }
  }
  calls.sort((left, right) => indexOfEntry(entries, left.entry) - indexOfEntry(entries, right.entry));
}

function resultFor(call: ToolCall, results: Map<string, ToolResult>): ToolResult {
  return required(results.get(call.id), `tool result for ${call.name} call ${call.id}`);
}

function indexOfEntry(entries: SessionEntry[], entry: SessionEntry | undefined): number {
  const target = required(entry, "session entry");
  return entries.indexOf(target);
}

/** Hermetic settings: these temp layers outrank any user global config. */
const PINNED_SETTINGS = `eval:
  js: true
  autoBackground:
    enabled: false
    thresholdMs: 60000
async:
  enabled: true
  maxJobs: 100
  printWake: true
bash:
  enabled: true
  autoBackground:
    enabled: false
tools:
  approvalMode: yolo
  approval:
    bash: allow
    eval: allow
    write: allow
    task_group_result: allow
`;

/** Store-tool approval is forced to prompt; other tools stay allowed. */
const DENY_STORE_SETTINGS = `eval:
  js: true
  autoBackground:
    enabled: false
    thresholdMs: 60000
async:
  enabled: true
  maxJobs: 100
  printWake: true
bash:
  enabled: true
  autoBackground:
    enabled: false
tools:
  approvalMode: yolo
  approval:
    bash: allow
    eval: allow
    write: allow
    read: allow
    task_group_result: allow
    task_group_store_result: prompt
`;

/** Project task-group config: explicit pool threshold of 3 for these runs. */
const PINNED_TASK_GROUP_CONFIG = {
  enabled: true,
  dispatcher: { mode: "off", detectMissedGroups: false },
  execution: {
    strategy: "auto",
    concurrency: "auto",
    pool: { enabled: "auto", threshold: 3, fallback: "fanout" },
  },
  join: { default: "all" },
  failure: { default: "collect" },
  output: { mode: "compact", perTaskChars: 1200, maxTotalChars: 8000, preserveHandles: true },
  summarize: { enabled: false, model: "smol" },
  telemetry: { enabled: true, detectMissedGroups: false },
  background: { retentionMinutes: 30 },
};

function writeIsolatedConfig(workspace: string, pinnedSettings: string = PINNED_SETTINGS): string {
  const testModel = process.env.TEST_MODEL;
  const settings = testModel
    ? `${pinnedSettings}\nmodelRoles:\n  tiny: ${JSON.stringify(testModel)}\n  smol: ${JSON.stringify(testModel)}\n  task: ${JSON.stringify(testModel)}\n`
    : pinnedSettings;
  mkdirSync(join(workspace, ".omp"), { recursive: true });
  writeFileSync(join(workspace, ".omp", "config.yml"), settings);
  writeFileSync(
    join(workspace, ".omp", "task-group.json"),
    `${JSON.stringify(PINNED_TASK_GROUP_CONFIG, null, 2)}\n`,
  );
  const overlayPath = join(workspace, "omp-overlay.yml");
  writeFileSync(overlayPath, settings);
  return overlayPath;
}

function barrierChildTask(input: {
  name: string;
  token: string;
  markerPath: string;
  ownStartedPath: string;
  startedPaths: readonly string[];
  afterMarkerSleepSeconds?: number;
}): string {
  const marker = basename(input.markerPath);
  const own = basename(input.ownStartedPath);
  const waitForMarker =
    `attempt=0; while [ ! -f ${marker} ] && [ "$attempt" -lt 60 ]; do sleep 1; attempt=$((attempt + 1)); done; test -f ${marker} || exit 23; `;
  const sleep = input.afterMarkerSleepSeconds !== undefined ? `sleep ${input.afterMarkerSleepSeconds}; ` : "";
  return (
    `You are background Workpool child ${input.name}. ` +
    "First call the bash tool with timeout 240 and this exact single-line command: " +
    `touch ${own}; ${waitForMarker}${sleep}printf '%s：' '${input.token}'; cat ${marker}; exit 0; ` +
    "Wait until that bash call returns. Then reply with exactly the stdout from that bash command. " +
    "Do not call any other tool besides the yield call required to finish this Workpool item."
  );
}

function simpleChildTask(token: string): string {
  return `Reply with exactly this token and nothing else: ${token}`;
}

function longChildTask(name: string, token: string, ownStartedPath: string): string {
  return (
    `You are cancellation probe child ${name}. ` +
    "First call the bash tool with timeout 240 and this exact single-line command: " +
    `touch ${basename(ownStartedPath)}; sleep 90; printf '%s' '${token}'; exit 0; ` +
    "Do not shorten the sleep. Wait until that bash call returns, then reply with exactly its stdout. " +
    "Do not call any other tool besides the yield call required to finish this Workpool item."
  );
}

function task(name: string, agent: string, instructions: string): Json {
  return { name, agent, task: instructions };
}

function specOf(input: {
  context: string;
  label: string;
  tasks: Json[];
}): Json {
  return {
    context: input.context,
    label: input.label,
    background: "require",
    tasks: input.tasks,
    join: { mode: "all" },
    failure: { mode: "collect" },
    execution: { strategy: "auto", concurrency: "auto" },
    output: { mode: "compact", perTaskChars: 1200, maxTotalChars: 8000, preserveHandles: true },
  };
}

function envelopeOf(spec: Json): string {
  return `ompTaskGroup(${JSON.stringify(spec)})`;
}

function requireBuiltArtifact(): void {
  if (!existsSync(OURS_DIST)) {
    throw new Error(`missing ${OURS_DIST} — run \`bun run build\` before TEST_INTEGRATION=1 tests`);
  }
}

function excerpt(text: string, max = 320): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

function evalOutcomes(calls: ToolCall[], results: Map<string, ToolResult>): EvalOutcome[] {
  const out: EvalOutcome[] = [];
  for (const call of calls) {
    if (call.name !== "eval") continue;
    const result = results.get(call.id);
    if (result === undefined) continue;
    const details = isRecord(result.details) ? result.details : undefined;
    const background = details !== undefined && isRecord(details.background) ? details.background : undefined;
    out.push({ call, result, details, background });
  }
  return out;
}

function dispatchedEvals(outcomes: EvalOutcome[]): EvalOutcome[] {
  return outcomes.filter(
    (outcome) =>
      outcome.background !== undefined &&
      outcome.background.delivery === "workpool-async" &&
      outcome.background.state === "dispatched",
  );
}

function collectEvalsFor(outcomes: EvalOutcome[], resultId: string): EvalOutcome[] {
  return outcomes.filter((outcome) => {
    const background = outcome.background;
    if (background === undefined) return false;
    const observedId =
      typeof background.resultId === "string"
        ? background.resultId
        : outcome.details !== undefined && typeof outcome.details.resultId === "string"
          ? outcome.details.resultId
          : undefined;
    if (observedId !== resultId) return false;
    return background.state === "pending" || background.state === "ready" || background.state === "failed";
  });
}

function assertDispatch(outcome: EvalOutcome, expectedTasks: number): DispatchInfo {
  const details = recordOf(outcome.details, "dispatch details");
  const background = recordOf(outcome.background, "dispatch details.background");
  expect(outcome.call.args.language).toBe("js");
  expect(outcome.call.args.timeout).toBe(0);
  expect(outcome.result.isError, `dispatch failed: ${outcome.result.text}`).toBe(false);
  expect(details.protocol).toBe("omp-task-group/v1");
  expect(details.state).toBe("dispatched");
  expect(isRecord(details.async), "dispatch must return synchronously, never as a host async eval").toBe(false);
  expect(background.protocol).toBe("omp-task-group/background-v1");
  expect(background.requested).toBe(true);
  expect(background.delivery).toBe("workpool-async");
  expect(background.state).toBe("dispatched");
  expect(typeof background.groupId).toBe("string");
  expect(background.groupId).toMatch(GROUP_ID_PATTERN);
  expect(typeof background.resultId).toBe("string");
  expect(background.resultId).toMatch(RESULT_ID_PATTERN);
  expect(background.poolName).toBe(background.groupId);
  expect(details.groupId).toBe(background.groupId);
  expect(background.taskCount).toBe(expectedTasks);
  expect(Array.isArray(background.itemIds)).toBe(true);
  const itemIds = (background.itemIds as unknown[]).map((id) => String(id));
  expect(itemIds).toHaveLength(expectedTasks);
  expect(new Set(itemIds).size).toBe(expectedTasks);
  expect(itemIds.every((id) => id.startsWith(`${background.groupId as string}#`))).toBe(true);
  expect(typeof background.collect).toBe("string");
  expect(background.collect).toContain("ompTaskGroupCollect");
  expect(background.collect).toContain(background.groupId as string);
  expect(background.collect).toContain(background.resultId as string);
  expect(typeof background.path).toBe("string");
  const path = background.path as string;
  expect(isAbsolute(path)).toBe(true);
  expect(path.startsWith(tmpdir())).toBe(true);
  expect(basename(dirname(path))).toMatch(RESULT_DIR_PATTERN);
  expect(basename(path)).toBe(`${background.groupId as string}.json`);

  expect(outcome.result.text).toContain(background.groupId as string);
  expect(outcome.result.text).toContain(background.resultId as string);
  expect(outcome.result.text).not.toContain("Task Group completed");
  expect(outcome.result.text).not.toContain("Full result: agent://");
  for (const token of [TOKEN_A, TOKEN_B, TOKEN_C, TOKEN_D, TOKEN_E, TOKEN_F, ...CANCELLED_TOKENS]) {
    expect(outcome.result.text, `dispatch receipt must not contain child token ${token}`).not.toContain(token);
  }

  const code = String(outcome.call.args.code ?? "");
  expect(code).toContain("workpool(");
  expect(code).not.toContain("ompTaskGroupCollect(");
  expect(code).not.toContain("tgWriteBackgroundResult");
  expect(code).not.toContain("writeFileSync");

  return {
    groupId: background.groupId as string,
    resultId: background.resultId as string,
    itemIds,
    path,
    eval: outcome,
  };
}

function assertReadyCollect(
  outcome: EvalOutcome,
  expected: {
    groupId: string;
    resultId: string;
    groupState: string;
    counts: { succeeded: number; failed: number; cancelled: number };
    isError: boolean;
  },
): ReadyCollectInfo {
  const details = recordOf(outcome.details, "collect details");
  const background = recordOf(outcome.background, "collect details.background");
  expect(outcome.call.args.language).toBe("js");
  expect(outcome.call.args.timeout).toBe(0);
  const collectCode = String(outcome.call.args.code ?? "");
  expect(collectCode).toContain("task_group_store_result");
  expect(collectCode).not.toContain("writeFileSync");
  expect(collectCode).not.toContain("openSync");
  expect(collectCode).not.toContain("renameSync");
  expect(collectCode).not.toContain("unlinkSync");
  expect(details.protocol).toBe("omp-task-group/v1");
  expect(details.groupId).toBe(expected.groupId);
  expect(details.resultId).toBe(expected.resultId);
  expect(background.protocol).toBe("omp-task-group/background-v1");
  expect(background.state).toBe("ready");
  expect(background.resultId).toBe(expected.resultId);
  expect(background.groupId).toBe(expected.groupId);
  expect(background.groupState).toBe(expected.groupState);
  const counts = recordOf(background.counts, "collect details.background.counts");
  expect(counts.succeeded).toBe(expected.counts.succeeded);
  expect(counts.failed).toBe(expected.counts.failed);
  expect(counts.cancelled).toBe(expected.counts.cancelled);
  expect(outcome.result.isError, `collect isError mismatch for ${expected.groupState}`).toBe(expected.isError);
  expect(typeof background.path).toBe("string");
  const path = background.path as string;
  expect(isAbsolute(path)).toBe(true);
  expect(path.startsWith(tmpdir())).toBe(true);
  expect(basename(dirname(path))).toMatch(RESULT_DIR_PATTERN);
  expect(basename(path)).toBe(`${expected.groupId}.json`);
  expect(typeof background.checksum).toBe("string");
  expect(background.checksum).toMatch(SHA256_PATTERN);
  expect(typeof background.payloadChars).toBe("number");
  expect(background.payloadChars as number).toBeGreaterThan(0);
  expect(outcome.result.text).toContain(expected.resultId);
  expect(outcome.result.text).toContain(path);
  expect(outcome.result.text).toContain("task_group_result");
  if (isRecord(background.pool)) {
    const pool = background.pool;
    expect(pool.closed).toBe(true);
    expect(pool.pending).toBe(0);
  }
  return {
    eval: outcome,
    background,
    path,
    checksum: background.checksum as string,
    payloadChars: background.payloadChars as number,
  };
}

function assertReadDelivery(input: {
  calls: ToolCall[];
  results: Map<string, ToolResult>;
  resultId: string;
  groupId: string;
  path: string;
  checksum: string;
  payloadChars: number;
  groupStateLabel: string;
  requiredParts: readonly string[];
  forbiddenParts: readonly string[];
  expectedSuccessNames?: readonly string[];
  expectedHandleCount?: number;
  allowErrorResult?: boolean;
}): ReadDelivery {
  expect(input.calls.length, "no materialized task_group_result reads").toBeGreaterThanOrEqual(1);
  let delivered = "";
  let deliveredEnd = 0;
  let total: number | undefined;
  let checksum: string | undefined;
  let payloadChars: number | undefined;
  for (let index = 0; index < input.calls.length; index++) {
    const readCall = input.calls[index] as ToolCall;
    const readResult = resultFor(readCall, input.results);
    if (input.allowErrorResult !== true) {
      expect(readResult.isError, `read ${index} failed: ${readResult.text}`).toBe(false);
    }
    const readDetails = recordOf(readResult.details, `read ${index} details`);
    const background = recordOf(readDetails.background, `read ${index} details.background`);
    expect(background.protocol).toBe("omp-task-group/background-v1");
    expect(background.delivery).toBe("background-file");
    expect(background.state).toBe("materialized");
    expect(background.resultId).toBe(input.resultId);
    expect(background.groupId).toBe(input.groupId);
    expect(background.path).toBe(input.path);
    expect(background.checksum).toBe(input.checksum);
    expect(background.payloadChars).toBe(input.payloadChars);
    expect(readResult.text).toContain(`Background Task Group result · ${input.resultId} · chars `);

    const segmentStart = background.offset;
    const segmentEnd = background.end;
    const deliveredChars = background.deliveredChars;
    expect(Number.isInteger(segmentStart)).toBe(true);
    expect(Number.isInteger(segmentEnd)).toBe(true);
    expect(Number.isInteger(deliveredChars)).toBe(true);
    const start = segmentStart as number;
    const end = segmentEnd as number;
    expect(start).toBeGreaterThanOrEqual(0);
    expect(start).toBeLessThanOrEqual(deliveredEnd);
    expect(end).toBeGreaterThanOrEqual(start);
    expect(deliveredChars as number).toBeGreaterThanOrEqual(end);
    if (total === undefined) {
      expect(typeof background.totalChars).toBe("number");
      total = background.totalChars as number;
    } else {
      expect(background.totalChars).toBe(total);
    }
    expect(deliveredChars as number).toBeLessThanOrEqual(total as number);
    payloadChars = background.payloadChars as number;
    checksum = background.checksum as string;
    if (index === input.calls.length - 1) {
      expect(background.complete, "last read did not report complete").toBe(true);
      expect(deliveredChars).toBe(total as number);
      expect(readResult.text).toContain('call task_group_result action="consume"');
    }
    delivered += readResult.text;
    deliveredEnd = Math.max(deliveredEnd, end);
  }
  expect(total).toBeDefined();
  expect(deliveredEnd).toBe(total as number);
  expect(delivered).toContain(input.groupStateLabel);
  for (const part of input.requiredParts) expect(delivered).toContain(part);
  for (const part of input.forbiddenParts) {
    expect(delivered, `gated result must not contain ${part}`).not.toContain(part);
  }
  if (input.expectedSuccessNames !== undefined) {
    for (const name of input.expectedSuccessNames) expect(delivered).toContain(`✓ ${name}`);
  }
  if (input.expectedHandleCount !== undefined) {
    expect((delivered.match(/Full result: agent:\/\//g) ?? []).length).toBe(input.expectedHandleCount);
  }
  return {
    delivered,
    checksum: required(checksum, "read checksum"),
    payloadChars: required(payloadChars, "read payloadChars"),
    total: required(total, "read total chars"),
  };
}

function assertConsume(input: {
  calls: ToolCall[];
  results: Map<string, ToolResult>;
  resultId: string;
  groupId: string;
  path: string;
  checksum: string;
  payloadChars: number;
}): ToolCall {
  const successful = input.calls.filter((call) => {
    const result = input.results.get(call.id);
    if (result === undefined || result.isError) return false;
    return !(isRecord(result.details) && result.details.alreadyConsumed === true);
  });
  expect(successful).toHaveLength(1);
  const consumeCall = successful[0] as ToolCall;
  const consumeResult = resultFor(consumeCall, input.results);
  expect(consumeResult.isError, `consume failed: ${consumeResult.text}`).toBe(false);
  expect(consumeResult.text).toContain("file deleted");
  const consumeDetails = recordOf(consumeResult.details, "consume details");
  expect(consumeDetails.resultId ?? consumeDetails.id).toBe(input.resultId);
  expect(consumeDetails.groupId).toBe(input.groupId);
  expect(consumeDetails.path).toBe(input.path);
  expect(consumeDetails.deleted).toBe(true);
  expect(consumeDetails.checksum).toBe(input.checksum);
  expect(consumeDetails.payloadChars).toBe(input.payloadChars);
  expect(existsSync(input.path), "consumed background result file must be deleted").toBe(false);
  return consumeCall;
}

function asyncEntriesOf(entries: SessionEntry[]): SessionEntry[] {
  return entries.filter(
    (entry) =>
      (entry.type === "custom_message" || entry.type === "custom") && entry.customType === "async-result",
  );
}

function asyncJobsOf(entry: SessionEntry): Json[] {
  const details = recordOf(entry.details, "async-result details");
  expect(Array.isArray(details.jobs), "async-result details.jobs must be an array").toBe(true);
  return (details.jobs as unknown[]).map((job) => recordOf(job, "async-result job"));
}

function finalAssistantTextAfter(entries: SessionEntry[], index: number): string {
  return entries
    .filter((entry) => entry.message?.role === "assistant" && indexOfEntry(entries, entry) >= index)
    .map((entry) => textOfEntry(entry))
    .filter((text) => text.trim().length > 0)
    .join("\n");
}

function renderDiagnostics(input: {
  run?: SpawnSyncReturns<string>;
  entries: SessionEntry[];
  calls: ToolCall[];
  results: Map<string, ToolResult>;
  sessionDir: string;
  workspace: string;
  paths: readonly string[];
  extraLines?: readonly string[];
}): string {
  const backgroundPaths = new Set<string>();
  for (const call of input.calls) {
    const result = input.results.get(call.id);
    if (result === undefined || !isRecord(result.details)) continue;
    const background = result.details.background;
    if (isRecord(background) && typeof background.path === "string") backgroundPaths.add(background.path);
  }
  const lines: string[] = [
    `sessionDir: ${input.sessionDir}`,
    `workspace: ${input.workspace}`,
    ...input.paths.map((path) => `path: ${path} exists=${existsSync(path)}`),
    ...[...backgroundPaths].map((path) => `background path: ${path} exists=${existsSync(path)}`),
    `session files: ${existsSync(input.sessionDir) ? readdirSync(input.sessionDir).join(", ") : "(missing)"}`,
  ];
  if (input.run !== undefined) {
    lines.push(
      `omp: status=${String(input.run.status)} signal=${String(input.run.signal)} error=${String(input.run.error)}`,
      "omp stdout tail:",
      excerpt(String(input.run.stdout ?? ""), 4000),
      "omp stderr tail:",
      excerpt(String(input.run.stderr ?? ""), 4000),
    );
  }
  if (input.extraLines !== undefined && input.extraLines.length > 0) {
    lines.push("", "Contract evidence:", ...input.extraLines);
  }
  lines.push("", "Tool calls (session order):");
  for (const call of input.calls) {
    const result = input.results.get(call.id);
    const path = typeof call.args.path === "string" ? ` path=${call.args.path}` : "";
    const action = typeof call.args.action === "string" ? ` action=${call.args.action}` : "";
    const id = typeof call.args.id === "string" ? ` id=${call.args.id}` : "";
    lines.push(
      `- ${call.name}${path}${action}${id} callId=${call.id} isError=${String(
        result?.isError ?? "no-result",
      )} text=${excerpt(result?.text ?? "")}`,
    );
  }
  lines.push("", "Session entries:");
  for (const [index, entry] of input.entries.entries()) {
    const role = entry.message?.role ?? entry.type ?? "?";
    const custom = entry.customType !== undefined ? ` customType=${entry.customType}` : "";
    const isError = entry.message?.isError === true ? " isError=true" : "";
    lines.push(`- [${index}] ${role}${custom}${isError} ${excerpt(textOfEntry(entry))}`);
  }
  return lines.join("\n");
}

function spawnOmp(input: {
  prompt: string;
  workspace: string;
  sessionDir: string;
  overlayPath: string;
  maxTimeSeconds: number;
  extensions?: string[];
  oursFirst?: boolean;
  approvalMode?: string;
  autoApprove?: boolean;
  tools?: string;
}): SpawnSyncReturns<string> {
  const args = [
    "-p",
    input.prompt,
    "--no-extensions",
  ];
  const extras = input.extensions ?? [];
  if (input.oursFirst !== false) {
    args.push("-e", OURS_DIST);
    for (const extension of extras) args.push("-e", extension);
  } else {
    for (const extension of extras) args.push("-e", extension);
    args.push("-e", OURS_DIST);
  }
  args.push(
    "--session-dir",
    input.sessionDir,
    "--config",
    input.overlayPath,
    "--no-skills",
    "--no-rules",
    "--no-context-files",
    "--no-lsp",
    "--no-prewalk",
    "--no-title",
    "--approval-mode",
    input.approvalMode ?? "yolo",
  );
  if (input.autoApprove !== false) args.push("--auto-approve");
  if (input.tools !== undefined) args.push("--tools", input.tools);
  args.push("--wait-async", "--max-time", String(input.maxTimeSeconds));
  const testModel = process.env.TEST_MODEL;
  if (testModel) args.push("--model", testModel, "--smol", testModel);
  return spawnSync("omp", args, {
    cwd: input.workspace,
    encoding: "utf8",
    timeout: (input.maxTimeSeconds + 60) * 1000,
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  });
}

/** Full dispatch → one aggregate notice → collect → segmented read → consume. */
describe("live background Workpool (TEST_INTEGRATION=1)", () => {
  test("3-task homogeneous all+collect: sync dispatch, parent continues, one native aggregate, collect, read, consume", () => {
    if (process.env.TEST_INTEGRATION !== "1") {
      console.log("skipping live background Workpool test (set TEST_INTEGRATION=1 to run)");
      return;
    }
    requireBuiltArtifact();

    const workspace = mkdtempSync(join(tmpdir(), "tg-pool-workspace-"));
    const sessionDir = mkdtempSync(join(tmpdir(), "tg-pool-session-"));
    const markerPath = join(workspace, "main-continued.marker");
    const startedPaths = [
      join(workspace, "child-alpha.started"),
      join(workspace, "child-beta.started"),
      join(workspace, "child-gamma.started"),
    ];
    const startedAlpha = required(startedPaths[0], "alpha sentinel");
    const startedBeta = required(startedPaths[1], "beta sentinel");
    const startedGamma = required(startedPaths[2], "gamma sentinel");
    const markerNonce = randomBytes(4).toString("hex");
    const markerContent = `main-continued-${markerNonce}`;
    const spec = specOf({
      context:
        "Three independent background Workpool probes. Each child touches its sentinel, waits briefly, then replies with its token and the main marker.",
      label: "workpool e2e",
      tasks: [
        task(
          "pool-alpha",
          "sonic",
          barrierChildTask({
            name: "pool-alpha",
            token: TOKEN_A,
            markerPath,
            ownStartedPath: startedAlpha,
            startedPaths,
          }),
        ),
        task(
          "pool-beta",
          "sonic",
          barrierChildTask({
            name: "pool-beta",
            token: TOKEN_B,
            markerPath,
            ownStartedPath: startedBeta,
            startedPaths,
          }),
        ),
        task(
          "pool-gamma",
          "sonic",
          barrierChildTask({
            name: "pool-gamma",
            token: TOKEN_C,
            markerPath,
            ownStartedPath: startedGamma,
            startedPaths,
          }),
        ),
      ],
    });
    const envelope = envelopeOf(spec);
    const prompt = [
      "You are running an end-to-end background Workpool test for omp-task-group.",
      "Follow these steps exactly, in order. Do not skip, combine, or reorder steps.",
      "",
      'Step 1. Call native eval with language "js", timeout 0, title "workpool dispatch", and code set to EXACTLY this envelope:',
      "",
      envelope,
      "",
      "The code argument must contain only that single line: no markdown fences, no comments, and no extra statements.",
      "This call dispatches a native Workpool and returns a dispatch receipt immediately. It is NOT the group result.",
      "",
      "Step 2. Immediately call the write tool with exactly this JSON argument object:",
      `  {"path":${JSON.stringify(markerPath)},"content":${JSON.stringify(markerContent)}}`,
      "",
      "This marker write must happen while the Workpool children are still running. It proves the main agent continued with another tool.",
      "",
      "Step 3. End your turn and wait. Do not poll, do not sleep, do not call the wait tool, and do not call any other tool until OMP delivers one async-result message.",
      "",
      "Step 4. Read the Step 1 dispatch receipt and note BOTH ids: groupId (also the pool name) and resultId (tgbg_...). The async-result message is the raw native Workpool aggregate, NOT the gated Task Group result. Do not treat it as the final result.",
      "",
      'Step 5. Call native eval with language "js", timeout 0, title "workpool collect", and code set to EXACTLY this one collect envelope, replacing the placeholders with the exact ids from Step 1:',
      "",
      'ompTaskGroupCollect({"groupId":"<groupId>","resultId":"<resultId>"})',
      "",
      "The code argument must contain only that single line. Do NOT reuse, copy, or paste any compiled JavaScript shown in an earlier eval result; the only accepted code starts with ompTaskGroupCollect. If the collect result says state \"pending\", run a foreground bash sleep 2 and call the same collect line again; repeat at most 3 times.",
      "",
      'Step 6. When collect reports state "ready", call task_group_result with {"action":"read","id":"<resultId>"} and no offset. Read the header and footer; if fewer than all characters were delivered, call read again with no offset. Repeat until complete=true.',
      "",
      'Step 7. Call task_group_result with {"action":"consume","id":"<resultId>"} and confirm the tool result says the file was deleted.',
      "",
      "Step 8. In Chinese, report the three child results exactly as read, then state that the background result file was consumed and deleted. Your final message must contain all three exact tokens: 工作池甲令牌-6D1E, 工作池乙令牌-3F8C, and 工作池丙令牌-2A7B. Do not call any more tools.",
    ].join("\n");

    let run: SpawnSyncReturns<string> | undefined;
    let entries: SessionEntry[] = [];
    let calls: ToolCall[] = [];
    let results = new Map<string, ToolResult>();
    let completed = false;
    let extraLines: string[] = [];
    try {
      const overlayPath = writeIsolatedConfig(workspace);
      run = spawnOmp({
        prompt,
        workspace,
        sessionDir,
        overlayPath,
        maxTimeSeconds: 600,
        tools: "eval,bash,read,write,task,task_group_result,task_group_store_result",
      });
      expect(run.error, `OMP process failed to start or finish: ${String(run.error)}`).toBeUndefined();
      entries = loadEntries(sessionDir);
      calls = toolCallsOf(entries);
      results = resultsByCallId(entries);
      expandEvalTaskGroupResultCalls(entries, calls, results);
      const outcomes = evalOutcomes(calls, results);
      extraLines = outcomes.map(
        (outcome) =>
          `eval bg=${JSON.stringify(outcome.background)} isError=${String(outcome.result.isError)} text=${excerpt(outcome.result.text, 500)}`,
      );

      // ── (1) one synchronous dispatch, no host async eval ────────────
      const dispatches = dispatchedEvals(outcomes);
      expect(dispatches, "expected exactly one background Workpool dispatch").toHaveLength(1);
      const dispatch = assertDispatch(dispatches[0] as EvalOutcome, 3);
      const dispatchResult = dispatch.eval.result;
      const dispatchEntryIndex = indexOfEntry(entries, dispatchResult.entry);

      // ── (2) main continued with another tool while children ran ─────
      const markerCalls = calls.filter(
        (call) =>
          (call.name === "write" && call.args.path === markerPath) ||
          (call.name === "bash" &&
            typeof call.args.command === "string" &&
            (call.args.command as string).includes(markerPath)),
      );
      const markerCall = markerCalls.find((call) => {
        const result = results.get(call.id);
        return result !== undefined && !result.isError;
      });
      expect(markerCall, "main agent did not create the continuation marker").toBeDefined();
      const marker = markerCall as ToolCall;
      const markerResult = resultFor(marker, results);
      expect(markerResult.isError, `marker tool failed: ${markerResult.text}`).toBe(false);
      expect(existsSync(markerPath), "main agent's continuation marker was never created").toBe(true);
      expect(readFileSync(markerPath, "utf8").trim()).toBe(markerContent);
      for (const started of startedPaths) {
        expect(existsSync(started), `child sentinel ${started} was never created`).toBe(true);
      }
      const markerEntryIndex = indexOfEntry(entries, marker.entry);
      expect(markerEntryIndex).toBeGreaterThan(dispatchEntryIndex);

      // Optional status/read checks before the marker must report pending.
      const preMarkerStatusCalls = calls.filter((call) => {
        if (call.name !== "task_group_result" || call.args.action !== "status") return false;
        const index = indexOfEntry(entries, call.entry);
        return index > dispatchEntryIndex && index < markerEntryIndex;
      });
      for (const statusCall of preMarkerStatusCalls) {
        const statusResult = results.get(statusCall.id);
        if (statusResult === undefined || statusResult.isError) continue;
        const statusDetails = recordOf(statusResult.details, "pending status details");
        expect(statusDetails.state).toBe("pending");
        expect(statusDetails.resultId ?? statusDetails.id).toBe(dispatch.resultId);
        expect(statusDetails.groupId).toBe(dispatch.groupId);
        expect(statusResult.text).not.toContain(TOKEN_A);
      }

      // ── (3) exactly one native aggregate notification ───────────────
      const asyncEntries = asyncEntriesOf(entries);
      expect(asyncEntries, "expected exactly one native aggregate async-result").toHaveLength(1);
      const asyncEntry = asyncEntries[0] as SessionEntry;
      const asyncJobs = asyncJobsOf(asyncEntry);
      expect(asyncJobs, "one pool must deliver exactly one aggregate job").toHaveLength(1);
      const asyncJob = asyncJobs[0] as Json;
      expect(asyncJob.type).toBe("task");
      expect(asyncJob.jobId).toBe(dispatch.groupId);
      expect(asyncJob.status).toBe("completed");
      const asyncText = textOfEntry(asyncEntry);
      expect(asyncText).toContain(dispatch.groupId);
      expect(asyncText).not.toContain("Task Group completed");
      const asyncEntryIndex = indexOfEntry(entries, asyncEntry);
      expect(asyncEntryIndex).toBeGreaterThan(markerEntryIndex);

      // ── (4) collect after the notice: ready file + receipt ──────────
      const collectOutcomes = collectEvalsFor(outcomes, dispatch.resultId);
      const pendingCollects = collectOutcomes.filter((outcome) => outcome.background?.state === "pending");
      for (const pending of pendingCollects) {
        expect(pending.result.isError).toBe(false);
        expect(pending.result.text).not.toContain("Task Group completed");
        for (const token of [TOKEN_A, TOKEN_B, TOKEN_C]) {
          expect(pending.result.text).not.toContain(token);
        }
      }
      const readyCollects = collectOutcomes.filter((outcome) => outcome.background?.state === "ready");
      expect(readyCollects.length, "collect never reported a ready result").toBeGreaterThanOrEqual(1);
      const readyOutcome = readyCollects[readyCollects.length - 1] as EvalOutcome;
      expect(indexOfEntry(entries, readyOutcome.result.entry)).toBeGreaterThan(asyncEntryIndex);
      const ready = assertReadyCollect(readyOutcome, {
        groupId: dispatch.groupId,
        resultId: dispatch.resultId,
        groupState: "completed",
        counts: { succeeded: 3, failed: 0, cancelled: 0 },
        isError: false,
      });
      for (const repeated of readyCollects.slice(0, -1)) {
        const repeatedBackground = recordOf(repeated.background, "repeated collect background");
        expect(repeated.result.isError).toBe(false);
        expect(repeatedBackground.checksum).toBe(ready.checksum);
        expect(repeatedBackground.payloadChars).toBe(ready.payloadChars);
        expect(repeatedBackground.path).toBe(ready.path);
      }
      // The file is written by collect and deleted by consume, so its
      // existence is proven by the materialized reads + deleted=true below.

      // ── (5) full segmented read of the gated result ─────────────────
      const readyIndex = indexOfEntry(entries, readyOutcome.result.entry);
      const resultCalls = calls.filter(
        (call) => call.name === "task_group_result" && indexOfEntry(entries, call.entry) > dispatchEntryIndex,
      );
      const consumeCalls = resultCalls.filter((call) => call.args.action === "consume");
      const successfulConsumeCalls = consumeCalls.filter((call) => {
        const result = results.get(call.id);
        if (result === undefined || result.isError) return false;
        return !(isRecord(result.details) && result.details.alreadyConsumed === true);
      });
      const firstConsumeIndexEntry =
        successfulConsumeCalls.length > 0
          ? indexOfEntry(entries, (successfulConsumeCalls[0] as ToolCall).entry)
          : Number.POSITIVE_INFINITY;
      const readCalls = resultCalls.filter((call) => {
        if (call.args.action !== "read") return false;
        const index = indexOfEntry(entries, call.entry);
        if (index <= readyIndex || index >= firstConsumeIndexEntry) return false;
        const result = results.get(call.id);
        if (result === undefined || result.isError || !isRecord(result.details)) return false;
        return isRecord(result.details.background) && result.details.background.state === "materialized";
      });
      const delivery = assertReadDelivery({
        calls: readCalls,
        results,
        resultId: dispatch.resultId,
        groupId: dispatch.groupId,
        path: ready.path,
        checksum: ready.checksum,
        payloadChars: ready.payloadChars,
        groupStateLabel: "Task Group completed",
        requiredParts: ["3/3 succeeded", "✓ pool-alpha", "✓ pool-beta", "✓ pool-gamma"],
        forbiddenParts: [],
        expectedSuccessNames: ["pool-alpha", "pool-beta", "pool-gamma"],
        expectedHandleCount: 3,
      });
      expect(delivery.delivered).toContain(TOKEN_A);
      expect(delivery.delivered).toContain(TOKEN_B);
      expect(delivery.delivered).toContain(TOKEN_C);
      for (const token of [TOKEN_A, TOKEN_B, TOKEN_C]) {
        const tokenIndex = delivery.delivered.indexOf(token);
        expect(tokenIndex, `missing child token ${token}`).toBeGreaterThanOrEqual(0);
        expect(delivery.delivered.slice(tokenIndex, tokenIndex + 1_600)).toContain(markerNonce);
      }
      expect(ready.path).toBe(dispatch.path);
      const firstReadCall = readCalls[0] as ToolCall;
      const firstReadDetails = recordOf(resultFor(firstReadCall, results).details, "first read details");
      const snapshot = recordOf(firstReadDetails.snapshot, "first read snapshot");
      expect(snapshot.strategy).toBe("pool");
      expect(Array.isArray(snapshot.tasks)).toBe(true);
      expect(snapshot.tasks).toHaveLength(3);
      expect(snapshot.groupId).toBe(dispatch.groupId);

      // ── (6) consume deletes the private file ────────────────────────
      const consumeCall = assertConsume({
        calls: consumeCalls,
        results,
        resultId: dispatch.resultId,
        groupId: dispatch.groupId,
        path: ready.path,
        checksum: delivery.checksum,
        payloadChars: delivery.payloadChars,
      });
      const consumeIndex = indexOfEntry(entries, consumeCall.entry);
      const finalText = finalAssistantTextAfter(entries, consumeIndex);
      expect(finalText.length).toBeGreaterThan(0);
      expect(finalText).toContain(TOKEN_A);
      expect(finalText).toContain(TOKEN_B);
      expect(finalText).toContain(TOKEN_C);
      expect(finalText).toMatch(/删除|已消费|消费|清理|removed|deleted|consumed/i);
      completed = true;
    } catch (error) {
      try {
        const diagnosticsPath = join(sessionDir, "diagnostics.txt");
        writeFileSync(
          diagnosticsPath,
          renderDiagnostics({
            run,
            entries,
            calls,
            results,
            sessionDir,
            workspace,
            paths: [markerPath, ...startedPaths],
            extraLines,
          }),
          "utf8",
        );
        console.error(`[pool-background.test] diagnostics written to ${diagnosticsPath}`);
      } catch (diagnosticsError) {
        console.error(`[pool-background.test] could not write diagnostics: ${String(diagnosticsError)}`);
      }
      throw error;
    } finally {
      const keep = !completed || process.env.KEEP_POOL_BACKGROUND_ARTIFACTS === "1";
      if (keep) {
        console.error(
          `[pool-background.test] artifacts kept: sessionDir=${sessionDir} workspace=${workspace}` +
            (completed ? " (KEEP_POOL_BACKGROUND_ARTIFACTS=1)" : " (test failed)"),
        );
      } else {
        rmSync(sessionDir, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
      }
    }
  }, 720_000);

  test("Smart Approve accepts the write-approved store in both extension load orders", () => {
    if (process.env.TEST_INTEGRATION !== "1" || SMART_APPROVE_EXTENSION === undefined) {
      console.log("skipping background Smart Approve test (set TEST_INTEGRATION=1 and SMART_APPROVE_EXTENSION)");
      return;
    }
    requireBuiltArtifact();
    const tokens = ["审批令牌甲-1A2B", "审批令牌乙-3C4D"];
    const spec = specOf({
      context: "Two independent approval probes.",
      label: "approval e2e",
      tasks: tokens.map((token, index) => task(`approve-${index + 1}`, "sonic", simpleChildTask(token))),
    });
    const envelope = envelopeOf(spec);
    const prompt = [
      "You are testing background Task Group approval. Follow these steps in order.",
      'Step 1. Call native eval with language "js", timeout 0, and code set to EXACTLY this envelope:',
      "",
      envelope,
      "",
      "Step 2. Call the native wait tool for the dispatched Workpool job until it reports completed. The wait output is only an aggregate preview, not a gated result.",
      'Step 3. Call native eval with language "js", timeout 0, and code set EXACTLY to ompTaskGroupCollect({"groupId":"<groupId>","resultId":"<resultId>"}) using the ids from the dispatch receipt. Do not copy compiled JavaScript.',
      'Step 4. When collect reports ready, read the full result with task_group_result {"action":"read","id":"<resultId>"} until complete=true, then consume it.',
      "Step 5. In Chinese, report whether collect reached ready, the group state, and whether the result file was deleted. Include both tokens if the gated result contains them.",
    ].join("\n");
    const orders = [
      ["Task Group before Smart Approve", true],
      ["Smart Approve before Task Group", false],
    ] as const;
    for (const [order, oursFirst] of orders) {
      const workspace = mkdtempSync(join(tmpdir(), "tg-pool-approve-"));
      const sessionDir = mkdtempSync(join(tmpdir(), "tg-pool-approve-session-"));
      let succeeded = false;
      try {
        const overlayPath = writeIsolatedConfig(workspace);
        const run = spawnOmp({
          prompt,
          workspace,
          sessionDir,
          overlayPath,
          maxTimeSeconds: 480,
          extensions: [SMART_APPROVE_EXTENSION],
          oursFirst,
          tools: "eval,bash,read,write,wait,task,task_group_result,task_group_store_result",
        });
        expect(run.error, `${order}: OMP failed to start`).toBeUndefined();
        const entries = loadEntries(sessionDir);
        const calls = toolCallsOf(entries);
        const results = resultsByCallId(entries);
        expandEvalTaskGroupResultCalls(entries, calls, results);
        const outcomes = evalOutcomes(calls, results);
        const dispatches = dispatchedEvals(outcomes);
        expect(dispatches.length, `${order}: no dispatch`).toBeGreaterThanOrEqual(1);
        const dispatch = assertDispatch(dispatches[0] as EvalOutcome, 2);
        const readyCollects = collectEvalsFor(outcomes, dispatch.resultId).filter(
          (outcome) => outcome.background?.state === "ready",
        );
        if (readyCollects.length === 0) {
          console.error(
            `[background-approve] ${order}: collect outcomes: ${outcomes
              .map((outcome) => `${outcome.call.args.title ?? "eval"} state=${String(outcome.background?.state)} stage=${String(outcome.background?.stage)} isError=${outcome.result.isError} text=${excerpt(outcome.result.text, 240)}`)
              .join(" | ")}`,
          );
          console.error(`[background-approve] sessionDir=${sessionDir}`);
        }
        expect(readyCollects.length, `${order}: collect never reached ready`).toBeGreaterThanOrEqual(1);
        const ready = assertReadyCollect(readyCollects[readyCollects.length - 1] as EvalOutcome, {
          groupId: dispatch.groupId,
          resultId: dispatch.resultId,
          groupState: recordOf(readyCollects[readyCollects.length - 1]?.background, `${order}: background`).groupState as string,
          counts: recordOf(
            recordOf(readyCollects[readyCollects.length - 1]?.background, `${order}: background`).counts,
            `${order}: counts`,
          ) as { succeeded: number; failed: number; cancelled: number },
          isError: (readyCollects[readyCollects.length - 1] as EvalOutcome).result.isError,
        });
        const readCalls = calls.filter(
          (call) =>
            call.name === "task_group_result" &&
            call.args.action === "read" &&
            call.args.id === dispatch.resultId,
        );
        expect(readCalls.length, `${order}: no gated read`).toBeGreaterThanOrEqual(1);
        const read = resultFor(readCalls[0] as ToolCall, results);
        expect(read.isError).toBe(false);
        expect(read.text).toContain(dispatch.resultId);
        const consumeCalls = calls.filter(
          (call) =>
            call.name === "task_group_result" &&
            call.args.action === "consume" &&
            call.args.id === dispatch.resultId,
        );
        expect(consumeCalls.length, `${order}: no consume`).toBeGreaterThanOrEqual(1);
        const consume = resultFor(consumeCalls[0] as ToolCall, results);
        expect(consume.isError).toBe(false);
        expect(consume.text).toContain("consumed");
        succeeded = true;
        expect(existsSync(ready.path), `${order}: consumed file still exists`).toBe(false);
      } finally {
        if (succeeded && process.env.KEEP_POOL_BACKGROUND_ARTIFACTS !== "1") {
          rmSync(sessionDir, { recursive: true, force: true });
          rmSync(workspace, { recursive: true, force: true });
        } else {
          console.error(`[background-approve] artifacts kept: sessionDir=${sessionDir} workspace=${workspace}`);
        }
      }
    }
  }, 720_000);

  test("headless approval denial of the store tool fails closed with no result file", () => {
    if (process.env.TEST_INTEGRATION !== "1") {
      console.log("skipping background approval-denial test (set TEST_INTEGRATION=1 to run)");
      return;
    }
    requireBuiltArtifact();
    const tokens = ["拒绝令牌丙-5E6F", "拒绝令牌丁-7A8B"];
    const spec = specOf({
      context: "Two independent denial probes.",
      label: "deny e2e",
      tasks: tokens.map((token, index) => task(`deny-${index + 1}`, "sonic", simpleChildTask(token))),
    });
    const envelope = envelopeOf(spec);
    const prompt = [
      "You are testing background Task Group write approval. Follow these steps in order.",
      'Step 1. Call native eval with language "js", timeout 0, and code set to EXACTLY this envelope:',
      "",
      envelope,
      "",
      "Step 2. End your turn and wait for OMP's async-result notice. Do not poll.",
      'Step 3. After the notice, call native eval again with language "js", timeout 0, and code set EXACTLY to ompTaskGroupCollect({"groupId":"<groupId>","resultId":"<resultId>"}) using the ids from the dispatch receipt. Do not copy compiled JavaScript. Call it only once; do not retry.',
      'Step 4. Report the collect tool result exactly. Do not call task_group_result read or consume if collect failed.',
    ].join("\n");
    const workspace = mkdtempSync(join(tmpdir(), "tg-pool-deny-"));
    const sessionDir = mkdtempSync(join(tmpdir(), "tg-pool-deny-session-"));
    try {
      const overlayPath = writeIsolatedConfig(workspace, DENY_STORE_SETTINGS);
      const run = spawnOmp({
        prompt,
        workspace,
        sessionDir,
        overlayPath,
        maxTimeSeconds: 300,
        approvalMode: "yolo",
        autoApprove: false,
        tools: "eval,bash,read,write,task,task_group_result,task_group_store_result",
      });
      expect(run.error, "denial OMP failed to start").toBeUndefined();
      const entries = loadEntries(sessionDir);
      const calls = toolCallsOf(entries);
      const results = resultsByCallId(entries);
      expandEvalTaskGroupResultCalls(entries, calls, results);
      const outcomes = evalOutcomes(calls, results);
      const dispatches = dispatchedEvals(outcomes);
      expect(dispatches.length, "denial: no dispatch").toBeGreaterThanOrEqual(1);
      const dispatch = assertDispatch(dispatches[0] as EvalOutcome, 2);
      const failures = collectEvalsFor(outcomes, dispatch.resultId).filter(
        (outcome) => outcome.background?.state === "failed",
      );
      expect(failures.length, "denial: collect did not fail closed").toBeGreaterThanOrEqual(1);
      const failed = failures[failures.length - 1] as EvalOutcome;
      expect(failed.background?.stage).toBe("write");
      expect(failed.result.isError).toBe(true);
      expect(failed.result.text).toContain("write");
      expect(existsSync(dispatch.path), "denial: a result file was written").toBe(false);
      const consumeCalls = calls.filter(
        (call) =>
          call.name === "task_group_result" &&
          call.args.action === "consume" &&
          call.args.id === dispatch.resultId,
      );
      expect(consumeCalls, "denial: consume must not run").toHaveLength(0);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 720_000);

  test("two concurrent background pools keep separate aggregates, collect handles, files and tokens", () => {
    if (process.env.TEST_INTEGRATION !== "1") {
      console.log("skipping concurrent background Workpool test (set TEST_INTEGRATION=1 to run)");
      return;
    }
    requireBuiltArtifact();

    const workspace = mkdtempSync(join(tmpdir(), "tg-pool-concurrent-"));
    const sessionDir = mkdtempSync(join(tmpdir(), "tg-pool-concurrent-session-"));
    const markerA = join(workspace, "main-continued-a.marker");
    const markerB = join(workspace, "main-continued-b.marker");
    const startedA = ["a1", "a2", "a3"].map((name) => join(workspace, `child-${name}.started`));
    const startedB = ["b1", "b2", "b3"].map((name) => join(workspace, `child-${name}.started`));
    const nonceA = randomBytes(4).toString("hex");
    const nonceB = randomBytes(4).toString("hex");
    const contentA = `pool-a-${nonceA}`;
    const contentB = `pool-b-${nonceB}`;

    const specA = specOf({
      context:
        "Three independent probes for pool A. Each child waits for the A sentinels and marker A, then replies.",
      label: "workpool concurrent A",
      tasks: [
        task(
          "alpha-one",
          "sonic",
          barrierChildTask({
            name: "alpha-one",
            token: TOKEN_A,
            markerPath: markerA,
            ownStartedPath: required(startedA[0], "a1 sentinel"),
            startedPaths: startedA,
          }),
        ),
        task(
          "alpha-two",
          "sonic",
          barrierChildTask({
            name: "alpha-two",
            token: TOKEN_B,
            markerPath: markerA,
            ownStartedPath: required(startedA[1], "a2 sentinel"),
            startedPaths: startedA,
          }),
        ),
        task(
          "alpha-three",
          "sonic",
          barrierChildTask({
            name: "alpha-three",
            token: TOKEN_C,
            markerPath: markerA,
            ownStartedPath: required(startedA[2], "a3 sentinel"),
            startedPaths: startedA,
          }),
        ),
      ],
    });
    const specB = specOf({
      context:
        "Three independent probes for pool B. Each child waits for the B sentinels and marker B, then stays busy briefly before replying.",
      label: "workpool concurrent B",
      tasks: [
        task(
          "beta-one",
          "sonic",
          barrierChildTask({
            name: "beta-one",
            token: TOKEN_D,
            markerPath: markerB,
            ownStartedPath: required(startedB[0], "b1 sentinel"),
            startedPaths: startedB,
            afterMarkerSleepSeconds: 20,
          }),
        ),
        task(
          "beta-two",
          "sonic",
          barrierChildTask({
            name: "beta-two",
            token: TOKEN_E,
            markerPath: markerB,
            ownStartedPath: required(startedB[1], "b2 sentinel"),
            startedPaths: startedB,
            afterMarkerSleepSeconds: 20,
          }),
        ),
        task(
          "beta-three",
          "sonic",
          barrierChildTask({
            name: "beta-three",
            token: TOKEN_F,
            markerPath: markerB,
            ownStartedPath: required(startedB[2], "b3 sentinel"),
            startedPaths: startedB,
            afterMarkerSleepSeconds: 20,
          }),
        ),
      ],
    });
    const envelopeA = envelopeOf(specA);
    const envelopeB = envelopeOf(specB);
    const prompt = [
      "You are running a concurrency-isolation test for two background Workpool groups.",
      "Follow these steps exactly, in order. Do not skip, combine, or reorder steps.",
      "",
      'Step 1. Call native eval with language "js", timeout 0, title "dispatch pool A", and code set to EXACTLY this envelope:',
      "",
      envelopeA,
      "",
      "This returns a dispatch receipt for group A. It is not the group result.",
      "",
      'Step 2. Call native eval again with language "js", timeout 0, title "dispatch pool B", and code set to EXACTLY this envelope:',
      "",
      envelopeB,
      "",
      "This returns a dispatch receipt for group B. It is not the group result.",
      "",
      "Step 3. Immediately call bash with timeout 30 and this exact command, which creates both continuation markers in one step:",
      `printf '%s' ${JSON.stringify(contentA)} > ${JSON.stringify(markerA)}; printf '%s' ${JSON.stringify(contentB)} > ${JSON.stringify(markerB)}`,
      "",
      "Step 4. End your turn and wait. Two async-result aggregate messages will arrive, one per pool. Do not poll, do not sleep, and do not call the wait tool.",
      "",
      "Step 5. For EACH of the two dispatch receipts, note its own groupId and resultId. The async-result messages are raw native aggregates, not gated Task Group results. Handle the groups independently and never mix their ids.",
      "",
      "Step 6. For each group, after its async-result message arrives, call native eval with language \"js\", timeout 0, and code set to EXACTLY its collect envelope:",
      "  group A: ompTaskGroupCollect({\"groupId\":\"<A groupId>\",\"resultId\":\"<A resultId>\"})",
      "  group B: ompTaskGroupCollect({\"groupId\":\"<B groupId>\",\"resultId\":\"<B resultId>\"})",
      "Substitute the exact ids; each code argument must contain only that one line. Do NOT reuse, copy, or paste compiled JavaScript from an earlier eval result. If a collect says state \"pending\", run a foreground bash sleep 2 and retry the same collect up to 3 times.",
      "",
      'Step 7. When a group is ready, read it fully with task_group_result {"action":"read","id":"<that group resultId>"} until complete=true, then consume it with {"action":"consume","id":"<that group resultId>"}.',
      "",
      "Step 8. In Chinese, report that both background Workpool groups completed independently and both result files were consumed and deleted. Your final message must contain all six exact tokens: 工作池甲令牌-6D1E, 工作池乙令牌-3F8C, 工作池丙令牌-2A7B, 工作池丁令牌-9E4F, 工作池戊令牌-1B6C, and 工作池己令牌-8D2A. Do not call any more tools.",
    ].join("\n");

    let run: SpawnSyncReturns<string> | undefined;
    let entries: SessionEntry[] = [];
    let calls: ToolCall[] = [];
    let results = new Map<string, ToolResult>();
    let completed = false;
    let extraLines: string[] = [];
    try {
      const overlayPath = writeIsolatedConfig(workspace);
      run = spawnOmp({ prompt, workspace, sessionDir, overlayPath, maxTimeSeconds: 700 });
      expect(run.error, `OMP process failed to start or finish: ${String(run.error)}`).toBeUndefined();
      entries = loadEntries(sessionDir);
      calls = toolCallsOf(entries);
      results = resultsByCallId(entries);
      expandEvalTaskGroupResultCalls(entries, calls, results);
      const outcomes = evalOutcomes(calls, results);
      extraLines = outcomes.map(
        (outcome) =>
          `eval bg=${JSON.stringify(outcome.background)} isError=${String(outcome.result.isError)} text=${excerpt(outcome.result.text, 500)}`,
      );

      const dispatches = dispatchedEvals(outcomes);
      expect(dispatches, "expected two background Workpool dispatches").toHaveLength(2);
      const dispatchA = assertDispatch(required(dispatches[0], "dispatch A"), 3);
      const dispatchB = assertDispatch(required(dispatches[1], "dispatch B"), 3);
      expect(dispatchA.groupId).not.toBe(dispatchB.groupId);
      expect(dispatchA.resultId).not.toBe(dispatchB.resultId);
      expect(dispatchA.path).not.toBe(dispatchB.path);
      expect(new Set([...dispatchA.itemIds, ...dispatchB.itemIds]).size).toBe(6);

      for (const marker of [markerA, markerB]) {
        expect(existsSync(marker), `main marker ${marker} was never created`).toBe(true);
      }
      expect(readFileSync(markerA, "utf8").trim()).toBe(contentA);
      expect(readFileSync(markerB, "utf8").trim()).toBe(contentB);
      for (const started of [...startedA, ...startedB]) {
        expect(existsSync(started), `child sentinel ${started} was never created`).toBe(true);
      }

      const dispatchEntryA = indexOfEntry(entries, dispatchA.eval.result.entry);
      const dispatchEntryB = indexOfEntry(entries, dispatchB.eval.result.entry);
      const markerCallFor = (path: string): ToolCall =>
        required(
          calls.find(
            (call) =>
              (call.name === "write" && call.args.path === path) ||
              (call.name === "bash" &&
                typeof call.args.command === "string" &&
                (call.args.command as string).includes(path)),
          ),
          `marker write call for ${path}`,
        );
      const markerEntryA = indexOfEntry(entries, markerCallFor(markerA).entry);
      const markerEntryB = indexOfEntry(entries, markerCallFor(markerB).entry);
      expect(markerEntryA).toBeGreaterThan(dispatchEntryA);
      expect(markerEntryB).toBeGreaterThan(dispatchEntryB);

      const asyncEntries = asyncEntriesOf(entries);
      expect(asyncEntries.length, "both concurrent pools must deliver aggregate results").toBeGreaterThanOrEqual(1);
      const asyncByGroup = new Map<string, SessionEntry>();
      let aggregateJobs = 0;
      for (const entry of asyncEntries) {
        for (const job of asyncJobsOf(entry)) {
          aggregateJobs++;
          expect(job.type).toBe("task");
          expect(job.status).toBe("completed");
          const jobId = String(job.jobId ?? "");
          expect([dispatchA.groupId, dispatchB.groupId]).toContain(jobId);
          expect(asyncByGroup.has(jobId), `duplicate aggregate notice for ${jobId}`).toBe(false);
          asyncByGroup.set(jobId, entry);
        }
      }
      expect(aggregateJobs, "each concurrent pool must deliver exactly one aggregate job").toBe(2);
      expect(asyncByGroup.has(dispatchA.groupId)).toBe(true);
      expect(asyncByGroup.has(dispatchB.groupId)).toBe(true);
      expect(indexOfEntry(entries, required(asyncByGroup.get(dispatchA.groupId), "A aggregate"))).toBeGreaterThan(markerEntryA);
      expect(indexOfEntry(entries, required(asyncByGroup.get(dispatchB.groupId), "B aggregate"))).toBeGreaterThan(markerEntryB);

      const verifyGroup = (input: {
        dispatch: DispatchInfo;
        asyncEntry: SessionEntry;
        groupStateTokens: readonly string[];
        forbiddenTokens: readonly string[];
        markerNonce: string;
        groupStateLabel: string;
        taskNames: readonly string[];
      }): void => {
        const asyncIndex = indexOfEntry(entries, input.asyncEntry);
        const collectOutcomes = collectEvalsFor(outcomes, input.dispatch.resultId);
        const readyCollects = collectOutcomes.filter((outcome) => outcome.background?.state === "ready");
        expect(readyCollects.length, `${input.dispatch.groupId}: no ready collect`).toBeGreaterThanOrEqual(1);
        const readyOutcome = readyCollects[readyCollects.length - 1] as EvalOutcome;
        expect(indexOfEntry(entries, readyOutcome.result.entry)).toBeGreaterThan(asyncIndex);
        const ready = assertReadyCollect(readyOutcome, {
          groupId: input.dispatch.groupId,
          resultId: input.dispatch.resultId,
          groupState: "completed",
          counts: { succeeded: 3, failed: 0, cancelled: 0 },
          isError: false,
        });

        const readyIndex = indexOfEntry(entries, readyOutcome.result.entry);
        const resultCalls = calls.filter(
          (call) =>
            call.name === "task_group_result" &&
            indexOfEntry(entries, call.entry) > readyIndex &&
            call.args.id === input.dispatch.resultId,
        );
        const consumeCalls = resultCalls.filter((call) => call.args.action === "consume");
        const successfulConsumeCalls = consumeCalls.filter((call) => {
          const result = results.get(call.id);
          if (result === undefined || result.isError) return false;
          return !(isRecord(result.details) && result.details.alreadyConsumed === true);
        });
        const firstConsumeEntry =
          successfulConsumeCalls.length > 0
            ? indexOfEntry(entries, (successfulConsumeCalls[0] as ToolCall).entry)
            : Number.POSITIVE_INFINITY;
        const readCalls = resultCalls.filter((call) => {
          if (call.args.action !== "read") return false;
          const index = indexOfEntry(entries, call.entry);
          if (index >= firstConsumeEntry) return false;
          const result = results.get(call.id);
          if (result === undefined || result.isError || !isRecord(result.details)) return false;
          return isRecord(result.details.background) && result.details.background.state === "materialized";
        });
        const delivery = assertReadDelivery({
          calls: readCalls,
          results,
          resultId: input.dispatch.resultId,
          groupId: input.dispatch.groupId,
          path: ready.path,
          checksum: ready.checksum,
          payloadChars: ready.payloadChars,
          groupStateLabel: input.groupStateLabel,
          requiredParts: input.taskNames.map((name) => `✓ ${name}`),
          forbiddenParts: input.forbiddenTokens,
          expectedSuccessNames: input.taskNames,
          expectedHandleCount: input.taskNames.length,
        });
        expect(ready.path).toBe(input.dispatch.path);
        for (const token of input.groupStateTokens) {
          expect(delivery.delivered).toContain(token);
          const tokenIndex = delivery.delivered.indexOf(token);
          expect(delivery.delivered.slice(tokenIndex, tokenIndex + 1_600)).toContain(input.markerNonce);
        }
        assertConsume({
          calls: consumeCalls,
          results,
          resultId: input.dispatch.resultId,
          groupId: input.dispatch.groupId,
          path: ready.path,
          checksum: delivery.checksum,
          payloadChars: delivery.payloadChars,
        });
      };

      verifyGroup({
        dispatch: dispatchA,
        asyncEntry: required(asyncByGroup.get(dispatchA.groupId), "A aggregate"),
        groupStateTokens: [TOKEN_A, TOKEN_B, TOKEN_C],
        forbiddenTokens: [TOKEN_D, TOKEN_E, TOKEN_F, nonceB],
        markerNonce: nonceA,
        groupStateLabel: "Task Group completed",
        taskNames: ["alpha-one", "alpha-two", "alpha-three"],
      });
      verifyGroup({
        dispatch: dispatchB,
        asyncEntry: required(asyncByGroup.get(dispatchB.groupId), "B aggregate"),
        groupStateTokens: [TOKEN_D, TOKEN_E, TOKEN_F],
        forbiddenTokens: [TOKEN_A, TOKEN_B, TOKEN_C, nonceA],
        markerNonce: nonceB,
        groupStateLabel: "Task Group completed",
        taskNames: ["beta-one", "beta-two", "beta-three"],
      });

      const finalText = finalAssistantTextAfter(entries, 0);
      expect(finalText).toContain(TOKEN_A);
      expect(finalText).toContain(TOKEN_B);
      expect(finalText).toContain(TOKEN_C);
      expect(finalText).toContain(TOKEN_D);
      expect(finalText).toContain(TOKEN_E);
      expect(finalText).toContain(TOKEN_F);
      expect(finalText).toMatch(/删除|已消费|消费|清理|removed|deleted|consumed/i);
      completed = true;
    } catch (error) {
      try {
        const diagnosticsPath = join(sessionDir, "diagnostics.txt");
        writeFileSync(
          diagnosticsPath,
          renderDiagnostics({
            run,
            entries,
            calls,
            results,
            sessionDir,
            workspace,
            paths: [markerA, markerB, ...startedA, ...startedB],
            extraLines,
          }),
          "utf8",
        );
        console.error(`[pool-background.test] diagnostics written to ${diagnosticsPath}`);
      } catch (diagnosticsError) {
        console.error(`[pool-background.test] could not write diagnostics: ${String(diagnosticsError)}`);
      }
      throw error;
    } finally {
      const keep = !completed || process.env.KEEP_POOL_BACKGROUND_ARTIFACTS === "1";
      if (keep) {
        console.error(
          `[pool-background.test] artifacts kept: sessionDir=${sessionDir} workspace=${workspace}` +
            (completed ? " (KEEP_POOL_BACKGROUND_ARTIFACTS=1)" : " (test failed)"),
        );
      } else {
        rmSync(sessionDir, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
      }
    }
  }, 780_000);

  test("cancelling a running pool yields an explicit cancelled/no-result outcome, never fake success", () => {
    if (process.env.TEST_INTEGRATION !== "1") {
      console.log("skipping background Workpool cancellation test (set TEST_INTEGRATION=1 to run)");
      return;
    }
    requireBuiltArtifact();

    const workspace = mkdtempSync(join(tmpdir(), "tg-pool-cancel-"));
    const sessionDir = mkdtempSync(join(tmpdir(), "tg-pool-cancel-session-"));
    const startedPaths = ["c1", "c2", "c3"].map((name) => join(workspace, `child-${name}.started`));
    const spec = specOf({
      context: "Three long-running probes used only to verify native Workpool cancellation.",
      label: "workpool cancel",
      tasks: [
        task(
          "cancel-one",
          "sonic",
          longChildTask("cancel-one", CANCELLED_TOKENS[0] as string, required(startedPaths[0], "c1 sentinel")),
        ),
        task(
          "cancel-two",
          "sonic",
          longChildTask("cancel-two", CANCELLED_TOKENS[1] as string, required(startedPaths[1], "c2 sentinel")),
        ),
        task(
          "cancel-three",
          "sonic",
          longChildTask("cancel-three", CANCELLED_TOKENS[2] as string, required(startedPaths[2], "c3 sentinel")),
        ),
      ],
    });
    const envelope = envelopeOf(spec);
    const sentinelWait = `for i in $(seq 1 300); do ${
      startedPaths.map((path) => `[ -f "${path}" ]`).join(" && ")
    } && exit 0; sleep 0.2; done; exit 1`;
    const prompt = [
      "You are running a cancellation test for a background Workpool.",
      "Follow these steps exactly, in order. Do not skip, combine, or reorder steps.",
      "",
      'Step 1. Call native eval with language "js", timeout 0, title "dispatch cancel", and code set to EXACTLY this envelope:',
      "",
      envelope,
      "",
      "This returns a dispatch receipt immediately; it is not the group result.",
      "",
      "Step 2. Read the dispatch receipt and note its groupId (the pool name) and resultId.",
      "",
      "Step 3. Call bash with timeout 90 and this exact command, which returns as soon as all three children have started:",
      sentinelWait,
      "",
      "Step 4. Call the write tool with exactly this JSON argument object, replacing <groupId> with the dispatch groupId:",
      '  {"path":"proc://<groupId>/kill"}',
      "",
      "Step 5. Run a foreground bash sleep 2 (command \"sleep 2\", timeout 30) so the cancellation cascade settles.",
      "",
      'Step 6. Call native eval with language "js", timeout 0, title "collect cancelled", and code set to EXACTLY this one collect envelope, replacing the placeholders with the dispatch ids:',
      "",
      'ompTaskGroupCollect({"groupId":"<groupId>","resultId":"<resultId>"})',
      "",
      "If it reports state \"pending\", run another foreground bash sleep 2 and call the same collect envelope again; repeat at most 3 times. The code argument must contain only that line; do NOT reuse or paste compiled JavaScript from an earlier eval result.",
      "",
      "Step 7. If collect reports state \"ready\" with groupState \"cancelled\" (its tool result may be marked as an error; that is expected), read it fully with task_group_result {\"action\":\"read\",\"id\":\"<resultId>\"} until complete=true, then consume it with {\"action\":\"consume\",\"id\":\"<resultId>\"}. If collect reports state \"failed\", do not read or consume; report its exact error. Never fabricate a successful result.",
      "",
      "Step 8. In Chinese, state that the Workpool was cancelled and no child succeeded, list the three child names, and say whether a result file was consumed or the collect failed closed. Do not include the probe tokens 取消甲令牌-5C7D, 取消乙令牌-0E9F, or 取消丙令牌-4A1B unless the gated text actually contains them.",
    ].join("\n");

    let run: SpawnSyncReturns<string> | undefined;
    let entries: SessionEntry[] = [];
    let calls: ToolCall[] = [];
    let results = new Map<string, ToolResult>();
    let completed = false;
    let extraLines: string[] = [];
    try {
      const overlayPath = writeIsolatedConfig(workspace);
      run = spawnOmp({ prompt, workspace, sessionDir, overlayPath, maxTimeSeconds: 600 });
      expect(run.error, `OMP process failed to start or finish: ${String(run.error)}`).toBeUndefined();
      entries = loadEntries(sessionDir);
      calls = toolCallsOf(entries);
      results = resultsByCallId(entries);
      expandEvalTaskGroupResultCalls(entries, calls, results);
      const outcomes = evalOutcomes(calls, results);
      extraLines = outcomes.map(
        (outcome) =>
          `eval bg=${JSON.stringify(outcome.background)} isError=${String(outcome.result.isError)} text=${excerpt(outcome.result.text, 500)}`,
      );

      const dispatches = dispatchedEvals(outcomes);
      expect(dispatches, "expected exactly one cancellation dispatch").toHaveLength(1);
      const dispatch = assertDispatch(dispatches[0] as EvalOutcome, 3);
      const dispatchIndex = indexOfEntry(entries, dispatch.eval.result.entry);

      for (const started of startedPaths) {
        expect(existsSync(started), `cancelled child sentinel ${started} was never created`).toBe(true);
      }

      const killPath = `proc://${dispatch.groupId}/kill`;
      const killCalls = calls.filter(
        (call) =>
          (call.name === "write" && call.args.path === killPath) ||
          (call.name === "bash" &&
            typeof call.args.command === "string" &&
            (call.args.command as string).includes(killPath)),
      );
      expect(killCalls.length, "model did not cancel the Workpool through proc://<groupId>/kill").toBeGreaterThanOrEqual(1);
      const killCall = killCalls[0] as ToolCall;
      expect(indexOfEntry(entries, killCall.entry)).toBeGreaterThan(dispatchIndex);
      const killResult = resultFor(killCall, results);
      expect(killResult.isError, `cancellation failed: ${killResult.text}`).toBe(false);
      expect(killResult.text).toMatch(/cancel/i);
      const killDetails = isRecord(killResult.details) ? killResult.details : undefined;
      const killProc = killDetails !== undefined && isRecord(killDetails.proc) ? killDetails.proc : undefined;
      const killCancelled = killProc !== undefined && Array.isArray(killProc.cancelled) ? killProc.cancelled : undefined;
      if (killCancelled !== undefined) {
        expect(
          killCancelled.some(
            (row) => isRecord(row) && row.id === dispatch.groupId && row.status === "cancelled",
          ),
          "proc cancellation receipt did not mark the pool job cancelled",
        ).toBe(true);
      } else {
        expect(killResult.text).toContain(dispatch.groupId);
      }

      const asyncEntries = asyncEntriesOf(entries);
      const cancelledJobs = asyncEntries.flatMap((entry) => asyncJobsOf(entry));
      expect(cancelledJobs.length, "a cancelled pool must not deliver a completed aggregate notice").toBeLessThanOrEqual(1);
      for (const job of cancelledJobs) {
        expect(job.jobId).toBe(dispatch.groupId);
        expect(job.status).not.toBe("completed");
      }
      for (const entry of asyncEntries) {
        expect(textOfEntry(entry)).toMatch(/cancel|failed/i);
        expect(textOfEntry(entry)).not.toContain("Task Group completed");
      }

      const collectOutcomes = collectEvalsFor(outcomes, dispatch.resultId);
      const terminal = collectOutcomes.filter(
        (outcome) => outcome.background?.state === "ready" || outcome.background?.state === "failed",
      );
      expect(terminal.length, "collect never reported a terminal cancellation outcome").toBeGreaterThanOrEqual(1);
      const terminalOutcome = terminal[terminal.length - 1] as EvalOutcome;
      const terminalBackground = recordOf(terminalOutcome.background, "terminal collect background");
      expect(indexOfEntry(entries, terminalOutcome.result.entry)).toBeGreaterThan(
        indexOfEntry(entries, killCall.entry),
      );

      const resultCalls = calls.filter(
        (call) =>
          call.name === "task_group_result" &&
          call.args.id === dispatch.resultId &&
          indexOfEntry(entries, call.entry) > indexOfEntry(entries, terminalOutcome.result.entry),
      );

      if (terminalBackground.state === "ready") {
        // Cancelled but drained: the collector can still produce the gated
        // cancelled report. This is not success, and it must be consumed.
        const ready = assertReadyCollect(terminalOutcome, {
          groupId: dispatch.groupId,
          resultId: dispatch.resultId,
          groupState: "cancelled",
          counts: { succeeded: 0, failed: 0, cancelled: 3 },
          isError: true,
        });
        expect(ready.path).toBe(dispatch.path);
        const consumeCalls = resultCalls.filter((call) => call.args.action === "consume");
        const successfulConsumeCalls = consumeCalls.filter((call) => {
          const result = results.get(call.id);
          if (result === undefined || result.isError) return false;
          return !(isRecord(result.details) && result.details.alreadyConsumed === true);
        });
        const firstConsumeEntry =
          successfulConsumeCalls.length > 0
            ? indexOfEntry(entries, (successfulConsumeCalls[0] as ToolCall).entry)
            : Number.POSITIVE_INFINITY;
        const readCalls = resultCalls.filter((call) => {
          if (call.args.action !== "read") return false;
          const index = indexOfEntry(entries, call.entry);
          if (index >= firstConsumeEntry) return false;
          const result = results.get(call.id);
          if (result === undefined || !isRecord(result.details)) return false;
          return isRecord(result.details.background) && result.details.background.state === "materialized";
        });
        const delivery = assertReadDelivery({
          calls: readCalls,
          results,
          resultId: dispatch.resultId,
          groupId: dispatch.groupId,
          path: ready.path,
          checksum: ready.checksum,
          payloadChars: ready.payloadChars,
          groupStateLabel: "Task Group cancelled",
          requiredParts: ["0/3 succeeded", "3 cancelled"],
          forbiddenParts: [...CANCELLED_TOKENS, "Task Group completed", "✓"],
          allowErrorResult: true,
        });
        expect(delivery.delivered).toContain("⊘ cancel-one");
        expect(delivery.delivered).toContain("⊘ cancel-two");
        expect(delivery.delivered).toContain("⊘ cancel-three");
        expect((delivery.delivered.match(/⊘/g) ?? []).length).toBe(3);
        assertConsume({
          calls: consumeCalls,
          results,
          resultId: dispatch.resultId,
          groupId: dispatch.groupId,
          path: ready.path,
          checksum: delivery.checksum,
          payloadChars: delivery.payloadChars,
        });
      } else {
        // The kill destroyed the service/handle before collect could snapshot
        // it. The contract requires an explicit failure, no file, no read.
        expect(terminalBackground.state).toBe("failed");
        expect(terminalOutcome.call.args.language).toBe("js");
        expect(terminalOutcome.call.args.timeout).toBe(0);
        expect(terminalOutcome.result.isError).toBe(true);
        expect(terminalBackground.checksum).toBeUndefined();
        const failedPath =
          typeof terminalBackground.path === "string" ? terminalBackground.path : dispatch.path;
        expect(existsSync(failedPath), "failed collect must not fabricate a result file").toBe(false);
        expect(terminalOutcome.result.text).toMatch(/handle|unavailable|state|pool/i);
        expect(terminalOutcome.result.text).not.toContain("Task Group completed");
        expect(resultCalls.filter((call) => call.args.action === "read")).toHaveLength(0);
        expect(resultCalls.filter((call) => call.args.action === "consume")).toHaveLength(0);
        const statusCalls = resultCalls.filter((call) => call.args.action === "status");
        for (const statusCall of statusCalls) {
          const statusResult = results.get(statusCall.id);
          if (statusResult === undefined || statusResult.isError || !isRecord(statusResult.details)) continue;
          expect(statusResult.details.state).toBe("pending");
        }
      }

      const finalText = finalAssistantTextAfter(entries, 0);
      expect(finalText).toMatch(/取消|cancel/i);
      expect(finalText).not.toMatch(/Task Group completed/);
      completed = true;
    } catch (error) {
      try {
        const diagnosticsPath = join(sessionDir, "diagnostics.txt");
        writeFileSync(
          diagnosticsPath,
          renderDiagnostics({
            run,
            entries,
            calls,
            results,
            sessionDir,
            workspace,
            paths: startedPaths,
            extraLines,
          }),
          "utf8",
        );
        console.error(`[pool-background.test] diagnostics written to ${diagnosticsPath}`);
      } catch (diagnosticsError) {
        console.error(`[pool-background.test] could not write diagnostics: ${String(diagnosticsError)}`);
      }
      throw error;
    } finally {
      const keep = !completed || process.env.KEEP_POOL_BACKGROUND_ARTIFACTS === "1";
      if (keep) {
        console.error(
          `[pool-background.test] artifacts kept: sessionDir=${sessionDir} workspace=${workspace}` +
            (completed ? " (KEEP_POOL_BACKGROUND_ARTIFACTS=1)" : " (test failed)"),
        );
      } else {
        rmSync(sessionDir, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
      }
    }
  }, 720_000);
});
