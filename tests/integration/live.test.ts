/**
 * omp-task-group — LIVE integration test (P0).
 *
 * Spawns a REAL headless OMP run (`omp -p`) and verifies the standard-eval
 * code-envelope protocol end-to-end from the persisted session file:
 *
 *   1. the model invokes the NATIVE eval tool exactly once with
 *      language "js", timeout 0, and a code parameter holding exactly one
 *      ompTaskGroup(<strict JSON>) envelope (no taskGroup argument, no other
 *      code, no other tools);
 *   2. the single eval tool result is finalized as the Task Group digest —
 *      exactly ONE group tool result for that eval call;
 *   3. NO child wake messages after it — the assistant continuation follows
 *      the single group tool result directly (one logical continuation);
 *   4. the delivered digest has the documented shape (glyphs, handles,
 *      duration) and finalizes with the stable snapshot details protocol
 *      "omp-task-group/v1";
 *   5. a telemetry custom entry is persisted with wake metrics whose groupId
 *      matches the digest handles.
 *
 * Cost: 10 cheap sonic children + one main-model turn. Gated:
 *   TEST_INTEGRATION=1 bun test tests/integration
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PLUGIN_ROOT = join(import.meta.dir, "..", "..");
const PROMPT_FILE = join(PLUGIN_ROOT, "tests", "integration", "fixtures", "live-prompt.txt");
const OURS_DIST = join(PLUGIN_ROOT, "dist", "index.js");

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

/** Group id shared by every digest handle (`Full result: agent://<gid>-<task>`). */
function digestGroupId(digest: string, taskNames: string[]): string {
  const prefix = "Full result: agent://";
  const ids = new Set<string>();
  for (const line of digest.split("\n")) {
    const idx = line.indexOf(prefix);
    if (idx < 0) continue;
    const rest = line.slice(idx + prefix.length);
    const name = taskNames.find((n) => rest.endsWith(`-${n}`));
    expect(name).toBeDefined();
    ids.add(rest.slice(0, rest.length - (name as string).length - 1));
  }
  expect(ids.size).toBe(1);
  return [...ids][0] as string;
}

function requireBuiltArtifact(): void {
  if (!existsSync(OURS_DIST)) {
    throw new Error(`missing ${OURS_DIST} — run \`bun run build\` before TEST_INTEGRATION=1 tests`);
  }
}

describe("live task group (TEST_INTEGRATION=1)", () => {
  test("10-child fanout via native eval envelope returns one logical continuation, no child wakes", () => {
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

      // (1) EXACTLY ONE eval call, in the standard envelope form: native eval
      // with language "js", timeout 0, and code = exactly one ompTaskGroup
      // envelope. No taskGroup argument (the pre-migration protocol), no other
      // tools, no second eval.
      const evalCalls = toolCallsOf(entries).filter((c) => c.name === "eval");
      const otherCalls = toolCallsOf(entries).filter((c) => c.name !== "eval");
      expect(otherCalls).toEqual([]);
      expect(evalCalls).toHaveLength(1);
      const call = evalCalls[0] as ToolCall;
      expect(call.args.language).toBe("js");
      expect(call.args.timeout).toBe(0);
      expect(call.args.taskGroup).toBeUndefined();
      const envelope = parseEnvelopeCode(call.args.code);
      expect(envelope.ok, `eval code is not a clean envelope: ${envelope.error}`).toBe(true);
      expect(envelope.spec).toEqual(fixtureSpec);
      // exactly one envelope occurrence in the code
      expect((envelope.code as string).split("ompTaskGroup(").length - 1).toBe(1);

      // (2) the eval call yields exactly ONE group tool result (the digest).
      const paired = pairCallsAndResults(entries);
      expect(paired).toHaveLength(1);
      const groupResult = paired[0]?.result;
      expect(groupResult, "no tool result for the envelope eval call").toBeDefined();
      const digest = (groupResult as ToolResult).text;
      expect(digest).toContain("Task Group ✓ · 10/10 succeeded · fanout");
      // (4) digest shape: per-task glyphs, handles, duration.
      expect((digest.match(/✓ probe-/g) ?? []).length).toBe(10);
      expect((digest.match(/Full result: agent:\/\//g) ?? []).length).toBe(10);
      expect(digest).toContain("duration:");

      // (4) finalization carries the stable snapshot details protocol.
      const details = (groupResult as ToolResult).details;
      expectRecord(details, "group result details must be an object");
      expect(details.protocol).toBe("omp-task-group/v1");

      // (3) zero child wakes: after the single group result there is ONLY one
      // assistant continuation and NO further toolResult/user deliveries.
      const groupIdx = entries.indexOf((groupResult as ToolResult).entry);
      expect(groupIdx).toBeGreaterThanOrEqual(0);
      const after = entries.slice(groupIdx + 1);
      const wakes = after.filter((e) => e.type === "message" && (e.message?.role === "toolResult" || e.message?.role === "user"));
      expect(wakes).toEqual([]);
      const continuations = after.filter((e) => e.type === "message" && e.message?.role === "assistant");
      expect(continuations).toHaveLength(1);

      // (5) telemetry persisted with wake metrics; groupId matches the digest
      // handle prefix (one and the same group).
      const telemetry = entries.filter((e) => e.type === "custom" && e.customType === "omp-task-group.telemetry.v1");
      expect(telemetry.length).toBeGreaterThanOrEqual(1);
      const data = telemetry[telemetry.length - 1]?.data;
      expectRecord(data, "telemetry data must be an object");
      expect(data.taskCount).toBe(10);
      expect(data.succeeded).toBe(10);
      expect(data.estimatedWakesAvoided).toBe(9);
      expect(Array.isArray(data.planReasons)).toBe(true);
      expect(data.groupId).toBe(digestGroupId(digest, taskNames));
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  }, 480_000);
});
