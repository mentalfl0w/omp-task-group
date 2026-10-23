import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import taskGroupExtension from "../../src/index";
import { EVAL_RESULT_PROTOCOL, EVAL_RESULT_TRANSPORT } from "../../src/compiler/program";
import type { ExtensionAPI, ExtensionContext } from "../../src/types";

const SPEC = {
  context: "Shared.",
  tasks: [
    { name: "alpha", agent: "sonic", task: "Reply alpha." },
    { name: "beta", agent: "sonic", task: "Reply beta." },
  ],
};

type Handler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

interface Harness {
  ctx: ExtensionContext;
  handlers: Map<string, Handler[]>;
  registeredTools: unknown[];
  entries: Array<{ customType: string; data: unknown }>;
  state: { aborts: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function makeHarness(cwd: string): Harness {
  const handlers = new Map<string, Handler[]>();
  const registeredTools: unknown[] = [];
  const entries: Array<{ customType: string; data: unknown }> = [];
  const state = { aborts: 0 };
  const ctx: ExtensionContext = {
    ui: {
      setStatus: () => {},
      setWidget: () => {},
      notify: () => {},
      select: async () => undefined,
      confirm: async () => false,
    },
    mode: "print",
    hasUI: false,
    cwd,
    sessionManager: {
      getSessionId: () => "session-test",
      getBranch: () => [],
    },
    setTimeout: () => 0,
    setInterval: () => 0,
    clearTimer: () => {},
    abort: () => {
      state.aborts += 1;
    },
  };
  const api = {
    on(event: string, handler: Handler): void {
      const bucket = handlers.get(event) ?? [];
      bucket.push(handler);
      handlers.set(event, bucket);
    },
    registerTool(tool: unknown): void {
      registeredTools.push(tool);
    },
    registerCommand: () => {},
    zod: {},
    appendEntry(customType: string, data?: unknown): void {
      entries.push({ customType, data });
    },
  } as unknown as ExtensionAPI;
  taskGroupExtension(api);
  return { ctx, handlers, registeredTools, entries, state };
}

async function emit(harness: Harness, eventName: string, event: unknown): Promise<unknown> {
  let result: unknown;
  for (const handler of harness.handlers.get(eventName) ?? []) {
    const next = await handler(event, harness.ctx);
    if (next !== undefined) result = next;
  }
  return result;
}

function envelope(spec: unknown = SPEC): string {
  return `ompTaskGroup(${JSON.stringify(spec)})`;
}

function rewrittenInput(result: unknown): Record<string, unknown> {
  expect(isRecord(result)).toBe(true);
  const input = isRecord(result) ? result.input : undefined;
  expect(isRecord(input)).toBe(true);
  return input as Record<string, unknown>;
}

function groupIdFrom(input: Record<string, unknown>): string {
  expect(typeof input.title).toBe("string");
  const title = String(input.title);
  expect(title.startsWith("task group: ")).toBe(true);
  return title.slice("task group: ".length);
}

async function withIsolatedHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "tg-envelope-hooks-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    await run(makeHarness(cwd));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
}

function evalCall(toolCallId: string, code: string): Record<string, unknown> {
  return {
    type: "tool_call",
    toolCallId,
    toolName: "eval",
    input: { language: "js", timeout: 0, code },
  };
}

describe("standard eval envelope hooks", () => {
  test("does not register eval and leaves ordinary eval unchanged", async () => {
    await withIsolatedHarness(async (harness) => {
      expect(harness.registeredTools).toEqual([]);
      const result = await emit(harness, "tool_call", evalCall("normal", "const x = 1 + 1; console.log(x)"));
      expect(result).toBeUndefined();
    });
  });

  test("blocks a recognized malformed envelope before native eval", async () => {
    await withIsolatedHarness(async (harness) => {
      const result = await emit(harness, "tool_call", evalCall("bad", "ompTaskGroup({invalid})"));
      expect(isRecord(result)).toBe(true);
      expect((result as Record<string, unknown>).block).toBe(true);
      expect(String((result as Record<string, unknown>).reason)).toContain("Task Group envelope invalid");
    });
  });

  test("rewrites a valid envelope and finalizes its native OMP JSON view", async () => {
    await withIsolatedHarness(async (harness) => {
      const rewrite = await emit(harness, "tool_call", evalCall("group", envelope()));
      const input = rewrittenInput(rewrite);
      expect(input.language).toBe("js");
      expect(input.timeout).toBe(0);
      expect(typeof input.code).toBe("string");
      expect(String(input.code)).toContain(EVAL_RESULT_PROTOCOL);
      expect(String(input.code)).not.toContain("ompTaskGroup(");
      const groupId = groupIdFrom(input);

      await emit(harness, "tool_execution_start", {
        type: "tool_execution_start",
        toolCallId: "group",
        toolName: "eval",
        args: input,
      });
      expect(harness.state.aborts).toBe(0);

      const wireResult = {
        protocol: EVAL_RESULT_PROTOCOL,
        groupId,
        strategy: "fanout",
        groupState: "completed",
        rawChildChars: 9,
        outcomes: [
          { name: "alpha", agent: "sonic", status: "succeeded", handle: `agent://${groupId}-alpha`, durationMs: 10, result: "alpha" },
          { name: "beta", agent: "sonic", status: "succeeded", handle: `agent://${groupId}-beta`, durationMs: 11, result: "beta" },
        ],
      };
      const resultChunk = {
        protocol: EVAL_RESULT_PROTOCOL,
        groupId,
        transport: EVAL_RESULT_TRANSPORT,
        chunkIndex: 0,
        chunkCount: 1,
        data: JSON.stringify(wireResult),
      };
      const output = JSON.stringify(resultChunk);
      const patch = await emit(harness, "tool_result", {
        type: "tool_result",
        toolCallId: "group",
        toolName: "eval",
        input,
        content: [{ type: "text", text: output }],
        details: {
          cells: [{
            index: 0,
            output,
            views: [{ text: output, view: { kind: "json", value: resultChunk } }],
          }],
        },
        isError: false,
      });
      expect(isRecord(patch)).toBe(true);
      const result = patch as Record<string, unknown>;
      expect(result.isError).toBe(false);
      expect(isRecord(result.details)).toBe(true);
      expect((result.details as Record<string, unknown>).protocol).toBe("omp-task-group/v1");
      expect(Array.isArray(result.content)).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
      expect(text).toContain("Task Group ✓ · 2/2 succeeded · fanout");
      expect(text).toContain(`Full result: agent://${groupId}-alpha`);
      expect(text).toContain(`Full result: agent://${groupId}-beta`);
      expect(harness.entries.some((entry) => entry.customType === "omp-task-group.telemetry.v1")).toBe(true);
    });
  });

  test("aborts and fails closed when another hook replaces the compiled input", async () => {
    await withIsolatedHarness(async (harness) => {
      const rewrite = await emit(harness, "tool_call", evalCall("collision", envelope()));
      const input = rewrittenInput(rewrite);
      await emit(harness, "tool_execution_start", {
        type: "tool_execution_start",
        toolCallId: "collision",
        toolName: "eval",
        args: { ...input, code: "console.log('other extension code')" },
      });
      expect(harness.state.aborts).toBe(1);
      const patch = await emit(harness, "tool_result", {
        type: "tool_result",
        toolCallId: "collision",
        toolName: "eval",
        input: { ...input, code: "console.log('other extension code')" },
        content: [],
        details: {},
        isError: true,
      });
      expect(isRecord(patch)).toBe(true);
      expect((patch as Record<string, unknown>).isError).toBe(true);
      const text = ((patch as Record<string, unknown>).content as Array<{ text: string }>)[0]?.text ?? "";
      expect(text).toContain("replaced the Task Group compiled eval input");
    });
  });

  test("fails closed when native eval auto-backgrounds", async () => {
    await withIsolatedHarness(async (harness) => {
      const rewrite = await emit(harness, "tool_call", evalCall("background", envelope()));
      const input = rewrittenInput(rewrite);
      const patch = await emit(harness, "tool_result", {
        type: "tool_result",
        toolCallId: "background",
        toolName: "eval",
        input,
        content: [],
        details: { async: { state: "running", jobId: "bg-1", type: "eval" } },
        isError: false,
      });
      expect(isRecord(patch)).toBe(true);
      expect((patch as Record<string, unknown>).isError).toBe(true);
      const text = ((patch as Record<string, unknown>).content as Array<{ text: string }>)[0]?.text ?? "";
      expect(text).toContain("auto-backgrounded (bg-1)");
    });
  });
});
