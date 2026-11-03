/**
 * omp-task-group — LIVE integration test (P0).
 *
 * Spawns a REAL headless OMP run (`omp -p`) and verifies the standard-eval
 * code-envelope protocol end-to-end from the persisted session file:
 *
 *   1. the model sends one native eval call from a strict envelope; OMP persists
 *      the effective compiled program, which carries the Task Group protocol and
 *      contains no `tool.hub()` call;
 *   2. the single eval tool result is finalized as the Task Group digest —
 *      exactly ONE group tool result for that eval call;
 *   3. NO child wake messages after it — the assistant continuation follows
 *      the single group tool result directly (one logical continuation);
 *   4. the delivered digest has ten task outcomes and worker handles, and the
 *      stable snapshot details record the actual Pool strategy;
 *   5. a telemetry entry is persisted with wake metrics whose groupId matches
 *      the snapshot groupId;
 *   6. when `SMART_APPROVE_EXTENSION` is set, the same one-result Pool contract
 *      holds with Smart Approve before and after Task Group because its Eval
 *      ToolInfo declares the proc-cancel capability marker.
 * Cost: 10 cheap sonic children plus twelve for the optional Smart Approve order
 * check. Gated: `TEST_INTEGRATION=1 bun test tests/integration`.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PLUGIN_ROOT = join(import.meta.dir, "..", "..");
const PROMPT_FILE = join(PLUGIN_ROOT, "tests", "integration", "fixtures", "live-prompt.txt");
const OURS_DIST = join(PLUGIN_ROOT, "dist", "index.js");
const SMART_APPROVE_EXTENSION = process.env.SMART_APPROVE_EXTENSION;

type Json = Record<string, unknown>;

interface SessionEntry {
  type?: string;
  customType?: string;
  data?: unknown;
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
  toolCallId?: string;
  text: string;
  details?: unknown;
  isError?: boolean;
}

function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function expectRecord(v: unknown, message?: string): asserts v is Json {
  expect(isRecord(v), message).toBe(true);
}

function loadEntries(sessionDir: string): SessionEntry[] {
  const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
  expect(files.length).toBe(1);
  const raw = readFileSync(join(sessionDir, files[0] ?? ""), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as SessionEntry);
}

function textOf(message: SessionEntry["message"]): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((c) => (isRecord(c) && c.type === "text" ? String(c.text) : ""))
      .join("\n");
  }
  return "";
}

/** toolCall content blocks (type "toolCall") in a message entry. */
function toolCallsOf(entries: SessionEntry[]): ToolCall[] {
  const out: ToolCall[] = [];
  for (const e of entries) {
    const m = e.message;
    if (!m || m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const c of m.content) {
      if (!isRecord(c) || c.type !== "toolCall") continue;
      if (typeof c.id !== "string" || typeof c.name !== "string" || !isRecord(c.arguments)) continue;
      out.push({ entry: e, id: c.id, name: c.name, args: c.arguments });
    }
  }
  return out;
}

function toolResultsOf(entries: SessionEntry[]): ToolResult[] {
  const out: ToolResult[] = [];
  for (const e of entries) {
    const m = e.message;
    if (!m || m.role !== "toolResult") continue;
    out.push({
      entry: e,
      toolCallId: typeof m.toolCallId === "string" ? m.toolCallId : undefined,
      text: textOf(m),
      details: m.details,
      isError: m.isError,
    });
  }
  return out;
}

/** Link each tool result to its originating call via toolCallId (fallback: positional). */
function pairCallsAndResults(entries: SessionEntry[]): Array<{ call: ToolCall; result?: ToolResult }> {
  const calls = toolCallsOf(entries).filter((c) => c.name === "eval");
  const results = toolResultsOf(entries);
  const byId = new Map(results.filter((r) => r.toolCallId).map((r) => [r.toolCallId as string, r]));
  const paired = calls.map((call) => {
    const result = byId.get(call.id) ?? (calls.length === results.length ? results[calls.indexOf(call)] : undefined);
    return { call, result };
  });
  if (paired.every((p) => p.result)) return paired;
  return calls.map((call, i) => ({ call, result: results[i] }));
}

interface EnvelopeParse {
  ok: boolean;
  spec?: Json;
  code?: string;
  error?: string;
}

/**
 * Envelope grammar: EXACTLY one `ompTaskGroup(<strict JSON>)` call — outer
 * whitespace and one terminal semicolon allowed, nothing else. `JSON.parse`
 * enforces strictness (double-quoted keys, no comments, no trailing commas).
 */
function parseEnvelopeCode(code: unknown): EnvelopeParse {
  if (typeof code !== "string" || code.trim().length === 0) {
    return { ok: false, error: "code is not a non-empty string" };
  }
  let t = code.trim();
  if (t.endsWith(";")) t = t.slice(0, -1).trim(); // one optional terminal semicolon
  if (t !== code.trim() && t.endsWith(";")) {
    return { ok: false, error: "more than one trailing statement" };
  }
  if (!t.startsWith("ompTaskGroup(")) {
    return { ok: false, error: "code does not start with ompTaskGroup(" };
  }
  if (!t.endsWith(")")) {
    return { ok: false, error: "envelope is not closed by a single trailing )" };
  }
  const inner = t.slice("ompTaskGroup(".length, -1);
  let spec: unknown;
  try {
    spec = JSON.parse(inner);
  } catch (e) {
    return { ok: false, error: `envelope argument is not strict JSON: ${String(e)}` };
  }
  if (!isRecord(spec) || !Array.isArray(spec.tasks) || spec.tasks.length === 0) {
    return { ok: false, error: "envelope argument is not a spec object with a non-empty tasks array" };
  }
  for (const task of spec.tasks) {
    if (!isRecord(task) || typeof task.name !== "string" || typeof task.agent !== "string") {
      return { ok: false, error: "envelope tasks must carry string name and agent" };
    }
  }
  return { ok: true, spec, code: t };
}

/** Envelope line embedded in the fixture prose. */
function envelopeLineOf(prompt: string): string {
  for (const line of prompt.split("\n")) {
    const t = line.trim();
    if (t.startsWith("ompTaskGroup(")) return t;
  }
  throw new Error("fixture does not contain an ompTaskGroup(...) envelope line");
}

/** Pool tasks may share worker handles; group identity comes from the snapshot. */
function snapshotGroupId(details: unknown): string {
  expectRecord(details, "group result details must be an object");
  const snapshot = details.snapshot;
  expectRecord(snapshot, "group result snapshot must be an object");
  expect(typeof snapshot.groupId).toBe("string");
  return snapshot.groupId as string;
}

function requireBuiltArtifact(): void {
  if (!existsSync(OURS_DIST)) {
    throw new Error(`missing ${OURS_DIST} — run \`bun run build\` before TEST_INTEGRATION=1 tests`);
  }
}

describe("live task group (TEST_INTEGRATION=1)", () => {
  test("10-child Pool via native eval envelope returns one logical continuation, no child wakes", () => {
    if (process.env.TEST_INTEGRATION !== "1") {
      console.log("skipping live integration test (set TEST_INTEGRATION=1 to run)");
      return;
    }
    requireBuiltArtifact();

    const sessionDir = mkdtempSync(join(tmpdir(), "tg-live-"));
    try {
      const prompt = readFileSync(PROMPT_FILE, "utf8");
      const fixtureEnvelope = parseEnvelopeCode(envelopeLineOf(prompt));
      expect(fixtureEnvelope.ok, fixtureEnvelope.error).toBe(true);
      const fixtureSpec = fixtureEnvelope.spec as Json;
      const taskNames = (fixtureSpec.tasks as Json[]).map((t) => String(t.name));
      expect(taskNames).toHaveLength(10);
      expect(taskNames[0]).toBe("probe-1");
      expect(taskNames[9]).toBe("probe-10");

      const res = spawnSync(
        "omp",
        ["-p", prompt, "--no-extensions", "-e", OURS_DIST, "--session-dir", sessionDir],
        { cwd: PLUGIN_ROOT, encoding: "utf8", timeout: 420_000 },
      );
      void res; // assertions run on session artifacts, not the exit code

      const entries = loadEntries(sessionDir);

      // (1) Exactly one standard native Eval call; the persisted result and
      // snapshot below verify that the compiled envelope ran successfully.
      const evalCalls = toolCallsOf(entries).filter((c) => c.name === "eval");
      const otherCalls = toolCallsOf(entries).filter((c) => c.name !== "eval");
      expect(otherCalls).toEqual([]);
      expect(evalCalls).toHaveLength(1);
      const call = evalCalls[0] as ToolCall;
      expect(call.args.language).toBe("js");
      expect(call.args.timeout).toBe(0);
      expect(call.args.taskGroup).toBeUndefined();
      expect(typeof call.args.code).toBe("string");

      // (2) the eval call yields exactly ONE group tool result (the digest).
      const paired = pairCallsAndResults(entries);
      expect(paired).toHaveLength(1);
      const groupResult = paired[0]?.result;
      expect(groupResult, "no tool result for the envelope eval call").toBeDefined();
      const digest = (groupResult as ToolResult).text;
      expect(digest).toContain("Task Group ✓ · 10/10 succeeded · pool");
      expect((digest.match(/✓ probe-/g) ?? []).length).toBe(10);
      expect((digest.match(/Full result: agent:\/\//g) ?? []).length).toBe(10);

      const details = (groupResult as ToolResult).details;
      expectRecord(details, "group result details must be an object");
      expect(details.protocol).toBe("omp-task-group/v1");
      const snapshot = details.snapshot;
      expectRecord(snapshot, "group snapshot must be an object");
      expect(snapshot.strategy).toBe("pool");
      expect(Array.isArray(snapshot.tasks)).toBe(true);
      const snapshotTasks = snapshot.tasks as Json[];
      expect(snapshotTasks).toHaveLength(10);
      expect(snapshotTasks.every((task) => task.durationMs === undefined && task.resolvedModel === undefined)).toBe(true);
      const groupId = snapshotGroupId(details);

      // (3) zero child wakes: after the single group result there is ONLY one
      // assistant continuation and NO further toolResult/user deliveries.
      const groupIdx = entries.indexOf((groupResult as ToolResult).entry);
      expect(groupIdx).toBeGreaterThanOrEqual(0);
      const after = entries.slice(groupIdx + 1);
      const wakes = after.filter((e) => e.type === "message" && (e.message?.role === "toolResult" || e.message?.role === "user"));
      expect(wakes).toEqual([]);
      const continuations = after.filter((e) => e.type === "message" && e.message?.role === "assistant");
      expect(continuations).toHaveLength(1);

      // (5) telemetry records the same group id as the authoritative snapshot.
      const telemetry = entries.filter((e) => e.type === "custom" && e.customType === "omp-task-group.telemetry.v1");
      expect(telemetry.length).toBeGreaterThanOrEqual(1);
      const data = telemetry[telemetry.length - 1]?.data;
      expectRecord(data, "telemetry data must be an object");
      expect(data.taskCount).toBe(10);
      expect(data.succeeded).toBe(10);
      expect(data.strategy).toBe("pool");
      expect(data.estimatedWakesAvoided).toBe(9);
      expect(Array.isArray(data.planReasons)).toBe(true);
      expect(data.groupId).toBe(groupId);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  }, 480_000);
  test("Smart Approve keeps Pool candidates safe in both extension load orders", () => {
    if (process.env.TEST_INTEGRATION !== "1") {
      console.log("skipping Smart Approve load-order test (set TEST_INTEGRATION=1)");
      return;
    }
    if (!SMART_APPROVE_EXTENSION) {
      console.log("skipping Smart Approve load-order test (set SMART_APPROVE_EXTENSION to its package path)");
      return;
    }
    requireBuiltArtifact();
    const spec: Json = {
      context: "Each child replies with the exact token requested by its task.",
      tasks: Array.from({ length: 6 }, (_, index) => ({
        name: `approve-${index + 1}`,
        agent: "sonic",
        task: `Reply exactly: token-${index + 1}`,
      })),
      join: { mode: "all" },
      failure: { mode: "collect" },
      execution: { strategy: "auto", concurrency: "auto" },
    };
    const code = `ompTaskGroup(${JSON.stringify(spec)})`;
    const prompt = [
      'Call native eval with language "js", timeout 0, and code set to exactly this envelope:',
      "",
      code,
      "",
      "After the tool returns, report the six outcomes. Do not call another tool.",
    ].join("\n");
    const orders = [
      ["Smart Approve before Task Group", [SMART_APPROVE_EXTENSION, OURS_DIST]],
      ["Task Group before Smart Approve", [OURS_DIST, SMART_APPROVE_EXTENSION]],
    ] as const;
    for (const [order, extensions] of orders) {
      const sessionDir = mkdtempSync(join(tmpdir(), "tg-smart-approve-"));
      try {
        const args = ["-p", prompt, "--no-extensions"];
        for (const extension of extensions) args.push("-e", extension);
        args.push("--session-dir", sessionDir);
        const result = spawnSync("omp", args, {
          cwd: PLUGIN_ROOT,
          encoding: "utf8",
          timeout: 180_000,
        });
        expect(result.error, `${order}: OMP process failed to start`).toBeUndefined();
        const entries = loadEntries(sessionDir);
        const evalCalls = toolCallsOf(entries).filter((call) => call.name === "eval");
        expect(toolCallsOf(entries).filter((call) => call.name !== "eval")).toEqual([]);
        expect(evalCalls).toHaveLength(1);
        const call = evalCalls[0] as ToolCall;
        expect(call.args.language).toBe("js");
        expect(call.args.timeout).toBe(0);
        const paired = pairCallsAndResults(entries);
        expect(paired).toHaveLength(1);
        const groupResult = paired[0]?.result;
        expect(groupResult, `${order}: missing joined Eval result`).toBeDefined();
        expect((groupResult as ToolResult).text).toContain("Task Group ✓ · 6/6 succeeded · pool");
        const digest = (groupResult as ToolResult).text;
        expect((digest.match(/✓ approve-/g) ?? []).length).toBe(6);
        expect((digest.match(/Full result: agent:\/\//g) ?? []).length).toBe(6);
        expectRecord((groupResult as ToolResult).details, `${order}: missing Task Group details`);
        const details = (groupResult as ToolResult).details as Json;
        expect(details.protocol).toBe("omp-task-group/v1");
        expectRecord(details.snapshot, `${order}: missing snapshot`);
        const snapshot = details.snapshot as Json;
        expect(snapshot.strategy).toBe("pool");
        expect(snapshot.fallbackReason).toBeUndefined();
        expect(Array.isArray(snapshot.tasks)).toBe(true);
        expect(snapshot.tasks).toHaveLength(6);
        const groupIdx = entries.indexOf((groupResult as ToolResult).entry);
        const after = entries.slice(groupIdx + 1);
        expect(after.filter((entry) => entry.type === "message" &&
          (entry.message?.role === "toolResult" || entry.message?.role === "user"))).toEqual([]);
        expect(after.filter((entry) => entry.type === "message" && entry.message?.role === "assistant"))
          .toHaveLength(1);
      } finally {
        rmSync(sessionDir, { recursive: true, force: true });
      }
    }
  }, 480_000);
});
