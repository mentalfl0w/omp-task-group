import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import taskGroupExtension from "../../src/index";
import {
  BACKGROUND_RESULT_FORMAT,
  EVAL_RESULT_PROTOCOL,
  EVAL_RESULT_TRANSPORT,
  POOL_BACKGROUND_COLLECT_TRANSPORT,
  POOL_BACKGROUND_DISPATCH_TRANSPORT,
} from "../../src/compiler/program";
import { sha256Hex } from "../../src/background/result-file";
import { runResultGate } from "../../src/result/gate";
import { validateSpec } from "../../src/schema/task-group";
import type { TaskOutcome } from "../../src/backend/interface";
import { TASK_GROUP_POOL_PROC_CANCEL_CAPABILITY } from "../../src/capabilities";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../src/types";

const SPEC = {
  context: "Shared.",
  tasks: [
    { name: "alpha", agent: "sonic", task: "Reply alpha." },
    { name: "beta", agent: "sonic", task: "Reply beta." },
  ],
};

const SIX_TASK_SPEC = {
  context: "Each child returns its assigned token.",
  tasks: Array.from({ length: 6 }, (_, index) => ({
    name: `task-${index + 1}`,
    agent: "sonic",
    task: `Return token-${index + 1}.`,
  })),
  join: { mode: "all" },
  failure: { mode: "collect" },
  execution: { strategy: "auto", concurrency: "auto" },
};

type ToolInventory = Array<{
  name: string;
  description?: string;
  sourceInfo?: { source?: string };
}>;
type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;

type Handler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

interface Harness {
  ctx: ExtensionCommandContext;
  handlers: Map<string, Handler[]>;
  registeredTools: unknown[];
  entries: Array<{ customType: string; data: unknown }>;
  commands: Map<string, CommandHandler>;
  notices: string[];
  state: { aborts: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function makeHarness(
  cwd: string,
  toolInventory: ToolInventory = [{ name: "eval", description: "Native Eval", sourceInfo: { source: "builtin" } }],
  mode: ExtensionContext["mode"] = "print",
): Harness {
  const handlers = new Map<string, Handler[]>();
  const registeredTools: unknown[] = [];
  const entries: Array<{ customType: string; data: unknown }> = [];
  const commands = new Map<string, CommandHandler>();
  const notices: string[] = [];
  const state = { aborts: 0 };
  const ctx: ExtensionCommandContext = {
    ui: {
      setStatus: () => {},
      setWidget: () => {},
      notify: (message) => notices.push(message),
      select: async () => undefined,
      confirm: async () => false,
    },
    mode,
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
    waitForIdle: async () => {},
  };
  const schemaNode: { optional(): unknown; describe(): unknown; default(value: unknown): unknown } = {
    optional: () => schemaNode,
    describe: () => schemaNode,
    default: () => schemaNode,
  };
  const zod = {
    object: () => schemaNode,
    string: () => schemaNode,
    number: () => schemaNode,
    boolean: () => schemaNode,
    literal: () => schemaNode,
    unknown: () => schemaNode,
    array: () => schemaNode,
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
    registerCommand(name: string, options: { handler: CommandHandler }): void {
      commands.set(name, options.handler);
    },
    getAllTools: () => toolInventory,
    zod,
    appendEntry(customType: string, data?: unknown): void {
      entries.push({ customType, data });
    },
  } as unknown as ExtensionAPI;
  taskGroupExtension(api);
  return { ctx, handlers, registeredTools, entries, commands, notices, state };
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

const ISOLATED_ENV_KEYS = ["PI_CODING_AGENT_DIR", "PI_CONFIG_DIR", "PI_CONFIG_FILES", "OMP_PROFILE", "PI_PROFILE"] as const;

async function withIsolatedHarness(
  run: (harness: Harness) => Promise<void>,
  toolInventory?: ToolInventory,
  mode: ExtensionContext["mode"] = "print",
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "tg-envelope-hooks-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const previousHome = process.env.HOME;
  const previousEnv = new Map(ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.HOME = home;
  for (const key of ISOLATED_ENV_KEYS) delete process.env[key];
  try {
    await run(makeHarness(cwd, toolInventory, mode));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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

interface RegisteredResultTool {
  name: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ): Promise<unknown>;
}

function resultTool(harness: Harness): RegisteredResultTool {
  const tool = harness.registeredTools.find(
    (candidate): candidate is RegisteredResultTool =>
      isRecord(candidate) && candidate.name === "task_group_result" && typeof candidate.execute === "function",
  );
  expect(tool).toBeDefined();
  return tool as RegisteredResultTool;
}

function storeResultTool(harness: Harness): RegisteredResultTool & { approval?: string } {
  const tool = harness.registeredTools.find(
    (candidate): candidate is RegisteredResultTool & { approval?: string } =>
      isRecord(candidate) && candidate.name === "task_group_store_result" && typeof candidate.execute === "function",
  );
  expect(tool).toBeDefined();
  return tool as RegisteredResultTool & { approval?: string };
}

const POOL_OUTCOMES: TaskOutcome[] = [
  { name: "alpha", agent: "sonic", status: "succeeded", result: "alpha" },
  { name: "beta", agent: "sonic", status: "succeeded", result: "beta" },
];

/** A structurally valid Workpool collect payload for the shared Result Gate. */
function poolPayloadJson(groupId: string, overrides: Record<string, unknown> = {}): string {
  const gate = runResultGate(POOL_OUTCOMES, validateSpec(SPEC), { groupState: "completed" });
  return JSON.stringify({
    protocol: EVAL_RESULT_PROTOCOL,
    groupId,
    strategy: "pool",
    groupState: "completed",
    rawChildChars: 10,
    outcomes: POOL_OUTCOMES,
    gateText: gate.deliveredText,
    gateMode: gate.mode,
    gatedChars: gate.deliveredChars,
    ...overrides,
  });
}

interface ActiveCollect {
  toolCallId: string;
  groupId: string;
  resultId: string;
  storeCapability: string;
  path: string;
  collectInput: Record<string, unknown>;
}

/**
 * Dispatch a background group, request the compiled Collect cell, and enter its
 * execution window so the store tool sees one active collect capability.
 */
async function startActiveCollect(harness: Harness, id: string): Promise<ActiveCollect> {
  const dispatchRewrite = await emit(harness, "tool_call", evalCall(`${id}-dispatch`, envelope({ ...SPEC, background: "require" })));
  const dispatchInput = rewrittenInput(dispatchRewrite);
  const groupId = backgroundGroupIdFrom(dispatchInput);
  const { resultId } = embeddedDispatch(dispatchInput);
  const dispatchPatch = await emit(harness, "tool_result", {
    type: "tool_result",
    toolCallId: `${id}-dispatch`,
    toolName: "eval",
    input: dispatchInput,
    content: [],
    details: receiptDetails(dispatchValue(groupId, resultId, ["i1", "i2"])),
    isError: false,
  });
  const path = String(backgroundDetails(dispatchPatch).path);
  const toolCallId = `${id}-collect`;
  const collectRewrite = await emit(
    harness,
    "tool_call",
    evalCall(toolCallId, `ompTaskGroupCollect(${JSON.stringify({ groupId, resultId })})`),
  );
  const collectInput = rewrittenInput(collectRewrite);
  const storeCapability = String(collectInput.code).match(/"storeCapability":"([a-f0-9]{64})"/)?.[1] ?? "";
  expect(storeCapability).toMatch(/^[a-f0-9]{64}$/);
  await emit(harness, "tool_execution_start", {
    type: "tool_execution_start",
    toolCallId,
    toolName: "eval",
    args: collectInput,
  });
  return { toolCallId, groupId, resultId, storeCapability, path, collectInput };
}

function wirePayload(groupId: string, strategy: "fanout" | "pool" = "fanout"): Record<string, unknown> {
  return {
    protocol: EVAL_RESULT_PROTOCOL,
    groupId,
    strategy,
    groupState: "completed",
    rawChildChars: 9,
    outcomes: [
      { name: "alpha", agent: "sonic", status: "succeeded", result: "alpha" },
      { name: "beta", agent: "sonic", status: "succeeded", result: "beta" },
    ],
  };
}

function resultFileText(
  input: Record<string, unknown>,
  groupId: string,
  resultId: string,
  strategy: "fanout" | "pool" = "fanout",
): string {
  expect(String(input.code)).toContain(resultId);
  const payloadJson = JSON.stringify(wirePayload(groupId, strategy));
  return JSON.stringify({
    format: BACKGROUND_RESULT_FORMAT,
    protocol: EVAL_RESULT_PROTOCOL,
    groupId,
    resultId,
    createdAtMs: Date.now(),
    payloadChars: payloadJson.length,
    sha256: sha256Hex(payloadJson),
    payloadJson,
  });
}

function receiptDetails(value: Record<string, unknown>): Record<string, unknown> {
  return { cells: [{ views: [{ view: { kind: "json", value } }] }] };
}

function backgroundDetails(patch: unknown): Record<string, unknown> {
  expect(isRecord(patch)).toBe(true);
  const details = isRecord(patch) ? patch.details : undefined;
  expect(isRecord(details)).toBe(true);
  const background = isRecord(details) ? details.background : undefined;
  expect(isRecord(background)).toBe(true);
  return background as Record<string, unknown>;
}

function toolText(result: unknown): string {
  expect(isRecord(result)).toBe(true);
  const content = isRecord(result) ? result.content : undefined;
  expect(Array.isArray(content)).toBe(true);
  return (content as Array<{ type: string; text: string }>)[0]?.text ?? "";
}

function backgroundGroupIdFrom(input: Record<string, unknown>): string {
  const title = String(input.title);
  const prefix = "task group background dispatch: ";
  expect(title.startsWith(prefix)).toBe(true);
  return title.slice(prefix.length);
}

function embeddedDispatch(input: Record<string, unknown>): { resultId: string } {
  const match = String(input.code).match(/const TG_BG_DISPATCH = (\{.*?\});/);
  expect(match).not.toBeNull();
  return JSON.parse(match?.[1] ?? "{}") as { resultId: string };
}

function dispatchValue(
  groupId: string,
  resultId: string,
  itemIds: string[],
): Record<string, unknown> {
  return {
    protocol: EVAL_RESULT_PROTOCOL,
    transport: POOL_BACKGROUND_DISPATCH_TRANSPORT,
    groupId,
    resultId,
    state: "dispatched",
    poolName: groupId,
    itemIds,
    taskCount: itemIds.length,
  };
}

function collectValue(
  groupId: string,
  resultId: string,
  path: string | undefined,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    protocol: EVAL_RESULT_PROTOCOL,
    transport: POOL_BACKGROUND_COLLECT_TRANSPORT,
    groupId,
    resultId,
    ...(path !== undefined ? { path } : {}),
    ...extra,
  };
}

describe("standard eval envelope hooks", () => {
  test("registers only task_group_result and leaves ordinary eval unchanged", async () => {
    await withIsolatedHarness(async (harness) => {
      expect(
        harness.registeredTools.map((tool) => (isRecord(tool) ? tool.name : undefined)),
      ).toEqual(["task_group_result", "task_group_store_result"]);
      const result = await emit(harness, "tool_call", evalCall("normal", "const x = 1 + 1; console.log(x)"));
      expect(result).toBeUndefined();
    });
  });


  test("blocks direct store-tool calls outside an executing Collect Eval", async () => {
    await withIsolatedHarness(async (harness) => {
      const result = await emit(harness, "tool_call", {
        type: "tool_call",
        toolCallId: "store-direct",
        toolName: "task_group_store_result",
        input: {
          groupId: "tgtestgroup",
          resultId: "tgbg_0123456789abcdef",
          payloadJson: "{}",
        },
      });
      expect(isRecord(result)).toBe(true);
      expect((result as Record<string, unknown>).block).toBe(true);
      expect(String((result as Record<string, unknown>).reason)).toContain("active matching Collect Eval capability");
    });
  });

  test("task_group_result fails closed when no background result was registered", async () => {
    await withIsolatedHarness(async (harness) => {
      const tool = resultTool(harness);
      const result = await tool.execute(
        "no-store",
        { action: "read", id: "tgbg_0123456789abcdef" },
        undefined,
        undefined,
        harness.ctx,
      );
      expect((result as Record<string, unknown>).isError).toBe(true);
      expect(toolText(result)).toContain("no background Task Group result has been registered");
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

  test("background dispatch returns verified push ids without any autoBackground configuration", async () => {
    await withIsolatedHarness(async (harness) => {
      // eval.autoBackground is effectively false (OMP default). The two-phase
      // Workpool path must not depend on it.
      const rewrite = await emit(
        harness,
        "tool_call",
        evalCall("background-ok", envelope({ ...SIX_TASK_SPEC, background: "require" })),
      );
      const input = rewrittenInput(rewrite);
      expect(String(input.title).startsWith("task group background dispatch: ")).toBe(true);
      expect(input.reset).toBeUndefined();
      const groupId = backgroundGroupIdFrom(input);
      expect(String(input.code)).toContain("workpool(");
      expect(String(input.code)).toContain("pool.push(");
      expect(String(input.code)).toContain("TG_BG_REGISTRY_KEY");
      expect(String(input.code)).not.toContain("tool.wait(");
      const { resultId } = embeddedDispatch(input);
      expect(resultId).toMatch(/^tgbg_[a-f0-9]{16}$/);

      await emit(harness, "tool_execution_start", {
        type: "tool_execution_start",
        toolCallId: "background-ok",
        toolName: "eval",
        args: input,
      });
      expect(harness.state.aborts).toBe(0);

      const itemIds = ["i1", "i2", "i3", "i4", "i5", "i6"];
      const patch = await emit(harness, "tool_result", {
        type: "tool_result",
        toolCallId: "background-ok",
        toolName: "eval",
        input,
        content: [],
        details: receiptDetails(dispatchValue(groupId, resultId, itemIds)),
        isError: false,
      });
      expect(isRecord(patch)).toBe(true);
      expect((patch as Record<string, unknown>).isError).toBe(false);
      const background = backgroundDetails(patch);
      expect(background.delivery).toBe("workpool-async");
      expect(background.state).toBe("dispatched");
      expect(background.groupId).toBe(groupId);
      expect(background.resultId).toBe(resultId);
      expect(background.poolName).toBe(groupId);
      expect(background.itemIds).toEqual(itemIds);
      expect(background.taskCount).toBe(6);
      expect(String(background.collect)).toBe(`ompTaskGroupCollect({"groupId":"${groupId}","resultId":"${resultId}"})`);
      expect(String(background.path).endsWith(`${groupId}.json`)).toBe(true);
      const notice = toolText(patch);
      expect(notice).toContain("not a result yet");
      expect(notice).toContain(resultId);
      expect(notice).toContain("not the Task Group result");
      expect(harness.notices).toEqual([]);

      const status = await resultTool(harness).execute(
        "status-pending",
        { action: "status", id: resultId },
        undefined,
        undefined,
        harness.ctx,
      );
      expect(toolText(status)).toContain("state=pending");
    });
  });

  test("background dispatch with details.async is never treated as success", async () => {
    await withIsolatedHarness(async (harness) => {
      const rewrite = await emit(
        harness,
        "tool_call",
        evalCall("background-async", envelope({ ...SIX_TASK_SPEC, background: "require" })),
      );
      const input = rewrittenInput(rewrite);
      const { resultId } = embeddedDispatch(input);
      const patch = await emit(harness, "tool_result", {
        type: "tool_result",
        toolCallId: "background-async",
        toolName: "eval",
        input,
        content: [],
        details: { async: { state: "running", jobId: "bg-9", type: "eval" } },
        isError: false,
      });
      expect(isRecord(patch)).toBe(true);
      expect((patch as Record<string, unknown>).isError).toBe(true);
      const text = toolText(patch);
      expect(text).toContain("auto-backgrounded (bg-9)");
      expect(text).toContain("dispatch is unconfirmed");
      expect(text).toContain("never treated as success");
      expect(text).toContain("do not re-dispatch");
      expect(text).toContain(backgroundGroupIdFrom(input));
      expect(text).toContain(resultId);
      expect(text).toContain("ompTaskGroupCollect");
      // The record is kept so a handle that did run can still be collected.
      const status = await resultTool(harness).execute(
        "status-kept",
        { action: "status", id: resultId },
        undefined,
        undefined,
        harness.ctx,
      );
      expect(toolText(status)).toContain("state=pending");
    });
  });

  test("background admission rejects non-pool specs and kernel reset", async () => {
    await withIsolatedHarness(async (harness) => {
      const heterogeneous = {
        ...SIX_TASK_SPEC,
        tasks: SIX_TASK_SPEC.tasks.map((task, index) => (index === 0 ? { ...task, agent: "reviewer" } : task)),
        background: "require",
      };
      const rejected = await emit(harness, "tool_call", evalCall("bg-hetero", envelope(heterogeneous)));
      expect((rejected as Record<string, unknown>).block).toBe(true);
      expect(String((rejected as Record<string, unknown>).reason)).toContain("requires the native Workpool path");

      const notAll = { ...SIX_TASK_SPEC, join: { mode: "any" }, background: "require" };
      const rejectedJoin = await emit(harness, "tool_call", evalCall("bg-any", envelope(notAll)));
      expect((rejectedJoin as Record<string, unknown>).block).toBe(true);

      const reset = await emit(harness, "tool_call", {
        ...evalCall("bg-reset", envelope({ ...SIX_TASK_SPEC, background: "require" })),
        input: {
          language: "js",
          timeout: 0,
          reset: true,
          code: envelope({ ...SIX_TASK_SPEC, background: "require" }),
        },
      });
      expect((reset as Record<string, unknown>).block).toBe(true);
      expect(String((reset as Record<string, unknown>).reason)).toContain("preserve the shared eval kernel");

      const summarize = await emit(
        harness,
        "tool_call",
        evalCall(
          "bg-summarize",
          envelope({
            ...SIX_TASK_SPEC,
            background: "require",
            output: { mode: "summarize", perTaskChars: 100, maxTotalChars: 1000, preserveHandles: true },
          }),
        ),
      );
      expect((summarize as Record<string, unknown>).block).toBe(true);
      expect(String((summarize as Record<string, unknown>).reason)).toContain("cannot run a summarizer");
    });
  });

  test("collect ready verifies the file; task_group_result reads and consumes it", async () => {
    await withIsolatedHarness(async (harness) => {
      const groupSpec = { ...SPEC, background: "require" };
      const dispatchRewrite = await emit(harness, "tool_call", evalCall("bg-dispatch", envelope(groupSpec)));
      const dispatchInput = rewrittenInput(dispatchRewrite);
      const groupId = backgroundGroupIdFrom(dispatchInput);
      const { resultId } = embeddedDispatch(dispatchInput);
      const dispatchPatch = await emit(harness, "tool_result", {
        type: "tool_result",
        toolCallId: "bg-dispatch",
        toolName: "eval",
        input: dispatchInput,
        content: [],
        details: receiptDetails(dispatchValue(groupId, resultId, ["i1", "i2"])),
        isError: false,
      });
      expect((dispatchPatch as Record<string, unknown>).isError).toBe(false);
      const path = String(backgroundDetails(dispatchPatch).path);

      const collectCode = `ompTaskGroupCollect(${JSON.stringify({ groupId, resultId })})`;
      const collectRewrite = await emit(harness, "tool_call", evalCall("bg-collect", collectCode));
      const collectInput = rewrittenInput(collectRewrite);
      expect(collectInput.title).toBe(`task group collect: ${groupId}`);
      expect(collectInput.reset).toBeUndefined();
      expect(String(collectInput.code)).toContain("TG_BG_RESULT");
      expect(String(collectInput.code)).toContain("pool.status()");
      expect(String(collectInput.code)).not.toContain("tool.wait(");

      const payloadJson = JSON.stringify(wirePayload(groupId, "pool"));
      writeFileSync(path, resultFileText(collectInput, groupId, resultId, "pool"), { mode: 0o600 });
      const readyReceipt = collectValue(groupId, resultId, path, {
        state: "ready",
        groupState: "completed",
        counts: { succeeded: 2, failed: 0, cancelled: 0 },
        checksum: sha256Hex(payloadJson),
        payloadChars: payloadJson.length,
      });
      const collectPatch = await emit(harness, "tool_result", {
        type: "tool_result",
        toolCallId: "bg-collect",
        toolName: "eval",
        input: collectInput,
        content: [],
        details: receiptDetails(readyReceipt),
        isError: false,
      });
      expect((collectPatch as Record<string, unknown>).isError).toBe(false);
      const collected = backgroundDetails(collectPatch);
      expect(collected.state).toBe("ready");
      expect(collected.groupState).toBe("completed");
      expect(collected.counts).toEqual({ succeeded: 2, failed: 0, cancelled: 0 });
      expect(collected.checksum).toBe(sha256Hex(payloadJson));
      expect(collected.payloadChars).toBe(payloadJson.length);
      const collectText = toolText(collectPatch);
      expect(collectText).toContain(resultId);
      expect(collectText).toContain(`task_group_result {"action":"read","id":"${resultId}"}`);

      const tool = resultTool(harness);
      const read = await tool.execute("read-1", { action: "read", id: resultId }, undefined, undefined, harness.ctx);
      const readText = toolText(read);
      expect(readText).toContain("Task Group ✓ · 2/2 succeeded · pool");
      expect(readText).toContain("alpha");
      expect(readText).toContain("beta");
      expect(existsSync(path)).toBe(true);

      const consume = await tool.execute("consume-1", { action: "consume", id: resultId }, undefined, undefined, harness.ctx);
      expect((consume as Record<string, unknown>).isError).not.toBe(true);
      expect(toolText(consume)).toContain("consumed");
      expect(existsSync(path)).toBe(false);

      const repeated = await tool.execute("consume-2", { action: "consume", id: resultId }, undefined, undefined, harness.ctx);
      expect((repeated as Record<string, unknown>).isError).not.toBe(true);
      expect(toolText(repeated)).toContain("already consumed");
      const repeatedDetails = (repeated as Record<string, unknown>).details as Record<string, unknown>;
      expect(repeatedDetails.alreadyConsumed).toBe(true);
      expect(repeatedDetails.deleted).toBe(false);
      expect(existsSync(path)).toBe(false);
    });
  });

  test("task_group_store_result is write-approved and rejects foreign or malformed payloads", async () => {
    await withIsolatedHarness(async (harness) => {
      const groupSpec = { ...SPEC, background: "require" };
      const dispatchRewrite = await emit(harness, "tool_call", evalCall("store-dispatch", envelope(groupSpec)));
      const dispatchInput = rewrittenInput(dispatchRewrite);
      const groupId = backgroundGroupIdFrom(dispatchInput);
      const { resultId } = embeddedDispatch(dispatchInput);
      const dispatchPatch = await emit(harness, "tool_result", {
        type: "tool_result",
        toolCallId: "store-dispatch",
        toolName: "eval",
        input: dispatchInput,
        content: [],
        details: receiptDetails(dispatchValue(groupId, resultId, ["i1", "i2"])),
        isError: false,
      });
      const path = String(backgroundDetails(dispatchPatch).path);
      const tool = storeResultTool(harness);
      expect(tool.approval).toBe("write");

      const foreign = await tool.execute(
        "store-foreign",
        { groupId: "tgothergroup", resultId, payloadJson: JSON.stringify(wirePayload("tgothergroup", "pool")) },
        undefined,
        undefined,
        harness.ctx,
      );
      expect((foreign as Record<string, unknown>).isError).toBe(true);

      const malformed = await tool.execute(
        "store-malformed",
        { groupId, resultId, payloadJson: "not json" },
        undefined,
        undefined,
        harness.ctx,
      );
      expect((malformed as Record<string, unknown>).isError).toBe(true);

      const noPath = await tool.execute(
        "store-path",
        { groupId, resultId, payloadJson: "{}", path: "/tmp/escape.json" },
        undefined,
        undefined,
        harness.ctx,
      );
      expect((noPath as Record<string, unknown>).isError).toBe(true);
      expect(existsSync(path)).toBe(false);
    });
  });

  test("an active collect admits only its own verified pool payload and kills the capability when it ends", async () => {
    await withIsolatedHarness(async (harness) => {
      const active = await startActiveCollect(harness, "store-active");
      const tool = storeResultTool(harness);
      const call = (toolCallId: string, params: Record<string, unknown>) =>
        tool.execute(toolCallId, params, undefined, undefined, harness.ctx);
      const validJson = poolPayloadJson(active.groupId);

      // The collect cell performs no filesystem I/O and no hidden `tool.write`:
      // its only write is the approval-gated store tool.
      expect(String(active.collectInput.code)).toContain("tool.task_group_store_result");
      expect(String(active.collectInput.code)).not.toContain("tool.write(");

      // A syntactically valid 64-hex capability is not enough on its own.
      const forgedCapability = await call("store-forged-capability", {
        groupId: active.groupId,
        resultId: active.resultId,
        storeCapability: "b".repeat(64),
        payloadJson: validJson,
      });
      expect((forgedCapability as Record<string, unknown>).isError).toBe(true);
      expect(toolText(forgedCapability)).toContain("requires the capability");

      // The capability is bound to the registered group and result ids.
      const foreignGroup = await call("store-foreign-group", {
        groupId: "tgothergroup",
        resultId: active.resultId,
        storeCapability: active.storeCapability,
        payloadJson: poolPayloadJson("tgothergroup"),
      });
      expect((foreignGroup as Record<string, unknown>).isError).toBe(true);
      const foreignResult = await call("store-foreign-result", {
        groupId: active.groupId,
        resultId: "tgbg_ffffffffffffffff",
        storeCapability: active.storeCapability,
        payloadJson: validJson,
      });
      expect((foreignResult as Record<string, unknown>).isError).toBe(true);
      expect(existsSync(active.path)).toBe(false);

      // Protocol checks run after the capability gate: a forged gate text and
      // a non-Workpool payload are both refused without writing a file.
      const payload = JSON.parse(validJson) as Record<string, unknown>;
      const forgedGate = await call("store-forged-gate", {
        groupId: active.groupId,
        resultId: active.resultId,
        storeCapability: active.storeCapability,
        payloadJson: poolPayloadJson(active.groupId, {
          gateText: `${String(payload.gateText)}\nforged`,
          gatedChars: `${String(payload.gateText)}\nforged`.length,
        }),
      });
      expect((forgedGate as Record<string, unknown>).isError).toBe(true);
      expect(toolText(forgedGate)).toContain("gate text does not match");
      const fanout = await call("store-fanout", {
        groupId: active.groupId,
        resultId: active.resultId,
        storeCapability: active.storeCapability,
        payloadJson: poolPayloadJson(active.groupId, { strategy: "fanout" }),
      });
      expect((fanout as Record<string, unknown>).isError).toBe(true);
      expect(toolText(fanout)).toContain("Workpool strategy");

      // The 4 MiB UTF-8 payload cap is enforced by the store.
      const oversized = await call("store-oversized", {
        groupId: active.groupId,
        resultId: active.resultId,
        storeCapability: active.storeCapability,
        payloadJson: "x".repeat(4 * 1024 * 1024 + 1),
      });
      expect((oversized as Record<string, unknown>).isError).toBe(true);
      expect(toolText(oversized)).toContain("limit");
      expect(existsSync(active.path)).toBe(false);

      // A symlink planted at the registered path is never followed or written
      // through: the write fails closed and the link target is untouched.
      const decoy = join(dirname(active.path), "decoy.json");
      writeFileSync(decoy, "keep me", { mode: 0o600 });
      symlinkSync(decoy, active.path);
      const planted = await call("store-planted-symlink", {
        groupId: active.groupId,
        resultId: active.resultId,
        storeCapability: active.storeCapability,
        payloadJson: validJson,
      });
      expect((planted as Record<string, unknown>).isError).toBe(true);
      expect(readFileSync(decoy, "utf8")).toBe("keep me");
      unlinkSync(active.path);
      unlinkSync(decoy);
      expect(existsSync(active.path)).toBe(false);

      // Extra path-like arguments never redirect the write.
      const escapePath = join(dirname(active.path), "escape.json");
      const stored = await call("store-valid", {
        groupId: active.groupId,
        resultId: active.resultId,
        storeCapability: active.storeCapability,
        payloadJson: validJson,
        path: escapePath,
        resultPath: escapePath,
      });
      expect((stored as Record<string, unknown>).isError).toBe(false);
      const storedDetails = (stored as Record<string, unknown>).details as Record<string, unknown>;
      expect(storedDetails.state).toBe("ready");
      expect(storedDetails.groupId).toBe(active.groupId);
      expect(storedDetails.resultId).toBe(active.resultId);
      expect(storedDetails.path).toBe(active.path);
      expect(existsSync(active.path)).toBe(true);
      expect(existsSync(escapePath)).toBe(false);
      const wrapper = JSON.parse(readFileSync(active.path, "utf8")) as Record<string, unknown>;
      expect(wrapper.payloadJson).toBe(validJson);
      expect(wrapper.sha256).toBe(sha256Hex(validJson));
      expect(wrapper.groupId).toBe(active.groupId);
      expect(wrapper.resultId).toBe(active.resultId);

      // An identical retry is idempotent; it never rewrites different content.
      const retry = await call("store-retry", {
        groupId: active.groupId,
        resultId: active.resultId,
        storeCapability: active.storeCapability,
        payloadJson: validJson,
      });
      expect((retry as Record<string, unknown>).isError).toBe(false);
      expect(((retry as Record<string, unknown>).details as Record<string, unknown>).alreadyStored).toBe(true);

      // The capability dies with the executing Collect Eval.
      await emit(harness, "tool_execution_end", {
        type: "tool_execution_end",
        toolCallId: active.toolCallId,
        toolName: "eval",
        result: undefined,
        isError: false,
      });
      const replay = await call("store-replay", {
        groupId: active.groupId,
        resultId: active.resultId,
        storeCapability: active.storeCapability,
        payloadJson: validJson,
      });
      expect((replay as Record<string, unknown>).isError).toBe(true);
      expect(toolText(replay)).toContain("requires the capability");
    });
  });

  test("session switch clears the collect capability, the store, and the private result file", async () => {
    await withIsolatedHarness(async (harness) => {
      const active = await startActiveCollect(harness, "store-session");
      const tool = storeResultTool(harness);
      const validJson = poolPayloadJson(active.groupId);
      const stored = await tool.execute(
        "store-session-write",
        {
          groupId: active.groupId,
          resultId: active.resultId,
          storeCapability: active.storeCapability,
          payloadJson: validJson,
        },
        undefined,
        undefined,
        harness.ctx,
      );
      expect((stored as Record<string, unknown>).isError).toBe(false);
      expect(existsSync(active.path)).toBe(true);
      const resultDir = dirname(active.path);

      await emit(harness, "session_switch", { type: "session_switch" });

      expect(existsSync(active.path)).toBe(false);
      expect(existsSync(resultDir)).toBe(false);

      const blocked = await emit(harness, "tool_call", {
        type: "tool_call",
        toolCallId: "store-session-direct",
        toolName: "task_group_store_result",
        input: {
          groupId: active.groupId,
          resultId: active.resultId,
          storeCapability: active.storeCapability,
          payloadJson: validJson,
        },
      });
      expect((blocked as Record<string, unknown>).block).toBe(true);

      const replay = await tool.execute(
        "store-session-replay",
        {
          groupId: active.groupId,
          resultId: active.resultId,
          storeCapability: active.storeCapability,
          payloadJson: validJson,
        },
        undefined,
        undefined,
        harness.ctx,
      );
      expect((replay as Record<string, unknown>).isError).toBe(true);
      expect(toolText(replay)).toContain("requires the capability");

      const status = await resultTool(harness).execute(
        "store-session-status",
        { action: "status", id: active.resultId },
        undefined,
        undefined,
        harness.ctx,
      );
      expect((status as Record<string, unknown>).isError).toBe(true);
      expect(toolText(status)).toContain("no background Task Group result has been registered");

      const collect = await emit(
        harness,
        "tool_call",
        evalCall(
          "store-session-collect",
          `ompTaskGroupCollect(${JSON.stringify({ groupId: active.groupId, resultId: active.resultId })})`,
        ),
      );
      expect((collect as Record<string, unknown>).block).toBe(true);
      expect(String((collect as Record<string, unknown>).reason)).toContain("no background result is registered");
    });
  });

  test("a second extension registration cannot collect, read, or write another registration's result", async () => {
    await withIsolatedHarness(async (first) => {
      const active = await startActiveCollect(first, "cross-session");
      const second = makeHarness(first.ctx.cwd);
      const validJson = poolPayloadJson(active.groupId);

      const foreignCollect = await emit(
        second,
        "tool_call",
        evalCall(
          "cross-session-collect",
          `ompTaskGroupCollect(${JSON.stringify({ groupId: active.groupId, resultId: active.resultId })})`,
        ),
      );
      expect((foreignCollect as Record<string, unknown>).block).toBe(true);
      expect(String((foreignCollect as Record<string, unknown>).reason)).toContain(
        "no background result is registered",
      );

      const foreignWrite = await storeResultTool(second).execute(
        "cross-session-store",
        {
          groupId: active.groupId,
          resultId: active.resultId,
          storeCapability: active.storeCapability,
          payloadJson: validJson,
        },
        undefined,
        undefined,
        second.ctx,
      );
      expect((foreignWrite as Record<string, unknown>).isError).toBe(true);
      expect(toolText(foreignWrite)).toContain("requires the capability");

      const foreignRead = await resultTool(second).execute(
        "cross-session-read",
        { action: "status", id: active.resultId },
        undefined,
        undefined,
        second.ctx,
      );
      expect((foreignRead as Record<string, unknown>).isError).toBe(true);
      expect(toolText(foreignRead)).toContain("no background Task Group result has been registered");
      expect(existsSync(active.path)).toBe(false);
    });
  });

  test("collect still-running reports pending without waiting and keeps the handle", async () => {
    await withIsolatedHarness(async (harness) => {
      const groupSpec = { ...SPEC, background: "require" };
      const dispatchRewrite = await emit(harness, "tool_call", evalCall("bg-dispatch2", envelope(groupSpec)));
      const dispatchInput = rewrittenInput(dispatchRewrite);
      const groupId = backgroundGroupIdFrom(dispatchInput);
      const { resultId } = embeddedDispatch(dispatchInput);
      const dispatchPatch = await emit(harness, "tool_result", {
        type: "tool_result",
        toolCallId: "bg-dispatch2",
        toolName: "eval",
        input: dispatchInput,
        content: [],
        details: receiptDetails(dispatchValue(groupId, resultId, ["i1", "i2"])),
        isError: false,
      });
      expect((dispatchPatch as Record<string, unknown>).isError).toBe(false);

      const collectCode = `ompTaskGroupCollect(${JSON.stringify({ groupId, resultId })})`;
      const collectRewrite = await emit(harness, "tool_call", evalCall("bg-collect2", collectCode));
      const collectInput = rewrittenInput(collectRewrite);
      const pending = collectValue(groupId, resultId, undefined, {
        state: "pending",
        groupState: undefined,
        counts: { succeeded: 1, failed: 0, cancelled: 0 },
        pool: { queued: 0, running: 1, completed: 1, failed: 0, cancelled: 0, closed: false, pending: 1, batches: 1 },
        reason: "the Workpool has not closed yet",
      });
      const patch = await emit(harness, "tool_result", {
        type: "tool_result",
        toolCallId: "bg-collect2",
        toolName: "eval",
        input: collectInput,
        content: [],
        details: receiptDetails(pending),
        isError: false,
      });
      expect((patch as Record<string, unknown>).isError).toBe(false);
      const background = backgroundDetails(patch);
      expect(background.state).toBe("pending");
      expect(background.counts).toEqual({ succeeded: 1, failed: 0, cancelled: 0 });
      const text = toolText(patch);
      expect(text).toContain("still draining");
      expect(text).toContain("did not wait");
      expect(text).toContain(collectCode);
    });
  });

  test("collect handle loss and state errors fail closed with no result", async () => {
    await withIsolatedHarness(async (harness) => {
      const groupSpec = { ...SPEC, background: "require" };
      const dispatchRewrite = await emit(harness, "tool_call", evalCall("bg-dispatch3", envelope(groupSpec)));
      const dispatchInput = rewrittenInput(dispatchRewrite);
      const groupId = backgroundGroupIdFrom(dispatchInput);
      const { resultId } = embeddedDispatch(dispatchInput);
      await emit(harness, "tool_result", {
        type: "tool_result",
        toolCallId: "bg-dispatch3",
        toolName: "eval",
        input: dispatchInput,
        content: [],
        details: receiptDetails(dispatchValue(groupId, resultId, ["i1", "i2"])),
        isError: false,
      });
      const collectCode = `ompTaskGroupCollect(${JSON.stringify({ groupId, resultId })})`;
      const collectRewrite = await emit(harness, "tool_call", evalCall("bg-collect3", collectCode));
      const collectInput = rewrittenInput(collectRewrite);
      const failed = collectValue(groupId, resultId, "/tmp/never-written.json", {
        state: "failed",
        stage: "handle",
        reason: "the retained Workpool registry is unavailable",
        groupState: undefined,
        counts: { succeeded: 0, failed: 0, cancelled: 0 },
      });
      const patch = await emit(harness, "tool_result", {
        type: "tool_result",
        toolCallId: "bg-collect3",
        toolName: "eval",
        input: collectInput,
        content: [],
        details: receiptDetails(failed),
        isError: false,
      });
      expect((patch as Record<string, unknown>).isError).toBe(true);
      expect(toolText(patch)).toContain("No result file was written");
      expect(toolText(patch)).toContain("do not re-dispatch");
      const background = backgroundDetails(patch);
      expect(background.state).toBe("failed");
      expect(background.stage).toBe("handle");
    });
  });

  test("background dispatch native eval error keeps the record and does not claim success", async () => {
    await withIsolatedHarness(async (harness) => {
      const rewrite = await emit(
        harness,
        "tool_call",
        evalCall("background-native-error", envelope({ ...SPEC, background: "require" })),
      );
      const input = rewrittenInput(rewrite);
      const { resultId } = embeddedDispatch(input);
      const patch = await emit(harness, "tool_result", {
        type: "tool_result",
        toolCallId: "background-native-error",
        toolName: "eval",
        input,
        content: [{ type: "text", text: "child spawn failed" }],
        details: {},
        isError: true,
      });
      expect(isRecord(patch)).toBe(true);
      expect((patch as Record<string, unknown>).isError).toBe(true);
      expect(toolText(patch)).toContain("native eval failed");
      expect(toolText(patch)).toContain("child spawn failed");
      expect(toolText(patch)).toContain(backgroundGroupIdFrom(input));
      expect(toolText(patch)).toContain(resultId);
      expect(toolText(patch)).toContain("ompTaskGroupCollect");
      // The cell may have dispatched before failing; keep the record so a
      // later collect can inspect it, and never rerun tasks.
      const status = await resultTool(harness).execute(
        "status-after-error",
        { action: "status", id: resultId },
        undefined,
        undefined,
        harness.ctx,
      );
      expect(toolText(status)).toContain("state=pending");
    });
  });

  test("background dispatch without a verified receipt fails closed", async () => {
    await withIsolatedHarness(async (harness) => {
      const rewrite = await emit(
        harness,
        "tool_call",
        evalCall("background-missing", envelope({ ...SPEC, background: "require" })),
      );
      const input = rewrittenInput(rewrite);
      const { resultId } = embeddedDispatch(input);
      const patch = await emit(harness, "tool_result", {
        type: "tool_result",
        toolCallId: "background-missing",
        toolName: "eval",
        input,
        content: [],
        details: { cells: [] },
        isError: false,
      });
      expect(isRecord(patch)).toBe(true);
      expect((patch as Record<string, unknown>).isError).toBe(true);
      expect(toolText(patch)).toContain("background dispatch was not confirmed");
      expect(toolText(patch)).toContain("do not re-dispatch");
      expect(toolText(patch)).toContain(backgroundGroupIdFrom(input));
      expect(toolText(patch)).toContain(resultId);
      expect(toolText(patch)).toContain("ompTaskGroupCollect");
      const status = await resultTool(harness).execute(
        "status-missing",
        { action: "status", id: resultId },
        undefined,
        undefined,
        harness.ctx,
      );
      expect(toolText(status)).toContain("state=pending");
    });
  });

  test("compiled collect retries rotate the capability and reject a concurrent write using the old one", async () => {
    await withIsolatedHarness(async (harness) => {
      const dispatchRewrite = await emit(
        harness,
        "tool_call",
        evalCall("compiled-retry-dispatch", envelope({ ...SPEC, background: "require" })),
      );
      const dispatchInput = rewrittenInput(dispatchRewrite);
      const groupId = backgroundGroupIdFrom(dispatchInput);
      const { resultId } = embeddedDispatch(dispatchInput);
      const dispatchPatch = await emit(harness, "tool_result", {
        type: "tool_result",
        toolCallId: "compiled-retry-dispatch",
        toolName: "eval",
        input: dispatchInput,
        content: [],
        details: receiptDetails(dispatchValue(groupId, resultId, ["i1", "i2"])),
        isError: false,
      });
      expect((dispatchPatch as Record<string, unknown>).isError).toBe(false);

      const collect = await emit(
        harness,
        "tool_call",
        evalCall("compiled-retry-first", `ompTaskGroupCollect(${JSON.stringify({ groupId, resultId })})`),
      );
      const compiledInput = rewrittenInput(collect);
      expect(String(compiledInput.code)).toContain(POOL_BACKGROUND_COLLECT_TRANSPORT);

      const capabilityMatch = String(compiledInput.code).match(/"storeCapability":"([a-f0-9]{64})"/);
      expect(capabilityMatch).not.toBeNull();
      const replay = await emit(harness, "tool_call", evalCall("compiled-retry-copy", String(compiledInput.code)));
      expect((replay as Record<string, unknown>).block).toBeUndefined();
      const replayInput = rewrittenInput(replay);
      expect(replayInput.code).not.toBe(compiledInput.code);
      expect(replayInput.title).toBe(`task group collect: ${groupId}`);
      const replayCapability = String(replayInput.code).match(/"storeCapability":"([a-f0-9]{64})"/);
      expect(replayCapability).not.toBeNull();
      const storeCapability = replayCapability?.[1] ?? "";
      await emit(harness, "tool_execution_start", {
        type: "tool_execution_start",
        toolCallId: "compiled-retry-copy",
        toolName: "eval",
        args: replayInput,
      });
      const spoofedStoreCall = await emit(harness, "tool_call", {
        type: "tool_call",
        toolCallId: "js-task_group_store_result-spoof",
        toolName: "task_group_store_result",
        input: { groupId, resultId, storeCapability: capabilityMatch?.[1] ?? "", payloadJson: "{}" },
      });
      expect((spoofedStoreCall as Record<string, unknown>).block).toBe(true);
      const bridgedStoreCall = await emit(harness, "tool_call", {
        type: "tool_call",
        toolCallId: "js-task_group_store_result-test",
        toolName: "task_group_store_result",
        input: { groupId, resultId, storeCapability, payloadJson: "{}" },
      });
      expect(bridgedStoreCall).toBeUndefined();
      await emit(harness, "tool_execution_end", {
        type: "tool_execution_end",
        toolCallId: "compiled-retry-copy",
        toolName: "eval",
      });

      const modified = await emit(
        harness,
        "tool_call",
        evalCall("compiled-retry-modified", `${String(compiledInput.code)}\\n// altered`),
      );
      expect((modified as Record<string, unknown>).block).toBe(true);
      expect(String((modified as Record<string, unknown>).reason)).toContain("does not match");
    });
  });

  test("collect envelope is strict and only addresses a registered group", async () => {
    await withIsolatedHarness(async (harness) => {
      const noStore = await emit(
        harness,
        "tool_call",
        evalCall("collect-no-store", `ompTaskGroupCollect({"groupId":"tgabc","resultId":"tgbg_0123456789abcdef"})`),
      );
      expect((noStore as Record<string, unknown>).block).toBe(true);
      expect(String((noStore as Record<string, unknown>).reason)).toContain("do not re-dispatch");

      const dispatchRewrite = await emit(
        harness,
        "tool_call",
        evalCall("bg-dispatch-strict", envelope({ ...SPEC, background: "require" })),
      );
      const dispatchInput = rewrittenInput(dispatchRewrite);
      const groupId = backgroundGroupIdFrom(dispatchInput);
      const { resultId } = embeddedDispatch(dispatchInput);

      const mismatch = await emit(
        harness,
        "tool_call",
        evalCall("collect-mismatch", `ompTaskGroupCollect({"groupId":"tgother","resultId":"${resultId}"})`),
      );
      expect((mismatch as Record<string, unknown>).block).toBe(true);
      expect(String((mismatch as Record<string, unknown>).reason)).toContain("does not match");

      const withPath = await emit(
        harness,
        "tool_call",
        evalCall("collect-path", `ompTaskGroupCollect({"groupId":"${groupId}","resultId":"${resultId}","path":"/tmp/x"})`),
      );
      expect((withPath as Record<string, unknown>).block).toBe(true);
      expect(String((withPath as Record<string, unknown>).reason)).toContain("collect envelope invalid");

      const reset = await emit(harness, "tool_call", {
        toolCallId: "collect-reset",
        toolName: "eval",
        input: {
          language: "js",
          timeout: 0,
          reset: true,
          code: `ompTaskGroupCollect({"groupId":"${groupId}","resultId":"${resultId}"})`,
        },
      });
      expect((reset as Record<string, unknown>).block).toBe(true);
    });
  });

  test("RPC mode uses the false setting default and blocks only an explicit enable", async () => {
    await withIsolatedHarness(
      async (harness) => {
        // Isolate the global layer so the test depends only on the setting
        // default, not on the machine's real ~/.omp/agent/config.yml.
        process.env.PI_CODING_AGENT_DIR = join(harness.ctx.cwd, "agent");
        const rewrite = await emit(harness, "tool_call", evalCall("rpc-default", envelope()));
        const input = rewrittenInput(rewrite);
        expect(String(input.code)).not.toContain("ompTaskGroup(");

        const command = harness.commands.get("task-group");
        expect(command).toBeDefined();
        await command!("background", harness.ctx);
        const message = harness.notices.at(-1) ?? "";
        expect(message).toContain("Extension mode: rpc");
        expect(message).toContain("autoBackground setting default: disabled");
        expect(message).toContain("Foreground requirement: satisfied (best effort)");
        expect(message).toContain("two-phase background does not require it");
        expect(message).toContain("unavailable");

        const omp = join(harness.ctx.cwd, ".omp");
        mkdirSync(omp, { recursive: true });
        writeFileSync(join(omp, "config.yml"), "eval: { autoBackground: { enabled: true } }\n");
        const blocked = await emit(harness, "tool_call", evalCall("rpc-enabled", envelope()));
        expect(isRecord(blocked)).toBe(true);
        expect((blocked as Record<string, unknown>).block).toBe(true);
        const reason = String((blocked as Record<string, unknown>).reason);
        expect(reason).toContain("eval.autoBackground.enabled=true");
        expect(reason).toContain("Foreground requirement: not satisfied");
      },
      undefined,
      "rpc",
    );
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

  test("aborts if another extension adds a kernel reset to a background dispatch", async () => {
    await withIsolatedHarness(async (harness) => {
      const rewrite = await emit(
        harness,
        "tool_call",
        evalCall("reset-collision", envelope({ ...SPEC, background: "require" })),
      );
      const input = rewrittenInput(rewrite);
      const modified = { ...input, reset: true };
      await emit(harness, "tool_execution_start", {
        type: "tool_execution_start",
        toolCallId: "reset-collision",
        toolName: "eval",
        args: modified,
      });
      expect(harness.state.aborts).toBe(1);
      const result = await emit(harness, "tool_result", {
        type: "tool_result",
        toolCallId: "reset-collision",
        toolName: "eval",
        input: modified,
        content: [],
        details: {},
        isError: true,
      });
      expect(isRecord(result) && result.isError).toBe(true);
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
      expect(text).toContain("separate async-result text preview");
      expect(text).toContain("did not cancel the host-owned job");
      expect(text).toContain("no Task Group Result Gate");
    });
  });
  test("wraps native Eval failures as explicit Task Group errors", async () => {
    await withIsolatedHarness(async (harness) => {
      const rewrite = await emit(harness, "tool_call", evalCall("native-error", envelope()));
      const input = rewrittenInput(rewrite);
      const patch = await emit(harness, "tool_result", {
        type: "tool_result",
        toolCallId: "native-error",
        toolName: "eval",
        input,
        content: [{ type: "text", text: "ToolError: Unknown tool from js runtime: hub" }],
        details: {},
        isError: true,
      });
      expect(isRecord(patch)).toBe(true);
      expect((patch as Record<string, unknown>).isError).toBe(true);
      const text = ((patch as Record<string, unknown>).content as Array<{ text: string }>)[0]?.text ?? "";
      expect(text).toContain("native eval failed");
      expect(text).toContain("Unknown tool from js runtime: hub");
    });
  });

  test("Pool accepts a marked Eval wrapper while built-in Eval needs no marker", async () => {
    const inventory: ToolInventory = [
      { name: "eval", description: "Native Eval", sourceInfo: { source: "builtin" } },
      {
        name: "eval",
        description: `Smart Approve Eval capability ${TASK_GROUP_POOL_PROC_CANCEL_CAPABILITY}`,
        sourceInfo: { source: "extension" },
      },
    ];
    await withIsolatedHarness(async (harness) => {
      await emit(harness, "tool_call", evalCall("pool-marked", envelope(SIX_TASK_SPEC)));
      const explain = harness.commands.get("task-group");
      expect(explain).toBeDefined();
      await explain!("explain", harness.ctx);
      const message = harness.notices.at(-1) ?? "";
      expect(message).toContain("strategy: pool");
      expect(message).not.toContain("downgraded from pool");
    }, inventory);
  });


  test("any unmarked Eval wrapper forces pre-dispatch Fanout and explains why", async () => {
    const inventory: ToolInventory = [
      { name: "eval", description: "Native Eval", sourceInfo: { source: "builtin" } },
      {
        name: "eval",
        description: `Compatible wrapper ${TASK_GROUP_POOL_PROC_CANCEL_CAPABILITY}`,
        sourceInfo: { source: "extension" },
      },
      { name: "eval", description: "Unmarked Eval wrapper", sourceInfo: { source: "extension" } },
    ];
    await withIsolatedHarness(async (harness) => {
      await emit(harness, "tool_call", evalCall("pool-unmarked", envelope(SIX_TASK_SPEC)));
      const explain = harness.commands.get("task-group");
      expect(explain).toBeDefined();
      await explain!("explain", harness.ctx);
      const message = harness.notices.at(-1) ?? "";
      expect(message).toContain("strategy: fanout (Pool candidate downgraded:");
      expect(message).toContain(TASK_GROUP_POOL_PROC_CANCEL_CAPABILITY);
      expect(message).toContain("using Fanout");
    }, inventory);
  });
});
