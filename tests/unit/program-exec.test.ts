import { describe, expect, test, vi } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import * as fsModule from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKGROUND_RESULT_FORMAT,
  compileFanoutProgram,
  compilePoolBackgroundCollectProgram,
  compilePoolBackgroundDispatchProgram,
  compilePoolProgram,
  EVAL_RESULT_PROTOCOL,
  EVAL_RESULT_TRANSPORT,
  POOL_BACKGROUND_COLLECT_TRANSPORT,
  POOL_BACKGROUND_DISPATCH_TRANSPORT,
} from "../../src/compiler/program";
import { sha256Hex } from "../../src/background/result-file";
import { runResultGate } from "../../src/result/gate";
import type { TaskOutcome } from "../../src/backend/interface";
import { validateSpec } from "../../src/schema/task-group";
import type { TaskGroupSpec } from "../../src/schema/task-group";

/**
 * Executable transport test: run the compiled program inside a mocked OMP eval
 * kernel (agent / wait / completion / workpool / console.log / phase / tool)
 * and verify JSON-view results, clipping, join/cancel semantics, and Pool recovery.
 */

interface Outcome {
  name: string;
  agent: string;
  status: string;
  handle?: string;
  durationMs?: number;
  resolvedModel?: string;
  result?: string;
  structured?: unknown;
  error?: string;
}

interface TaskGroupResultPayload {
  protocol: string;
  groupId: string;
  strategy: string;
  groupState: string;
  rawChildChars: number;
  outcomes: Outcome[];
  groupError?: string;
  fallbackReason?: string;
  summary?: string;
  summaryError?: string;
  gateText?: string;
  gateMode?: "compact" | "structured" | "summarize";
  gatedChars?: number;
}

interface MockKernel {
  consoleValues: unknown[];
  phases: string[];
  completionPrompts: string[];
  run(program: string): Promise<void>;
}

type FnMap = Record<string, unknown>;

/** Execute a compiled program inside an OMP-shaped prelude. */
function installRunner(kernel: MockKernel, fns: FnMap): void {
  fns.console = {
    log: (...values: unknown[]) => {
      kernel.consoleValues.push(...values);
    },
  };
  fns.phase = (title: string) => {
    kernel.phases.push(String(title));
  };
  kernel.run = (program: string) => {
    const fn = new Function(
      "agent", "wait", "completion", "workpool", "console", "phase", "tool", "fs",
      `return async () => {\n${program}\n}`,
    ) as (...args: unknown[]) => () => Promise<void>;
    const runner = fn(fns.agent, fns.wait, fns.completion, fns.workpool, fns.console, fns.phase, fns.tool, fns.fs);
    return runner();
  };
}

/** Assemble an OMP-shaped prelude and execute one compiled program inside it. */
function makeKernel(results: Array<unknown>, extras: { fs?: unknown } = {}): MockKernel {
  const kernel: MockKernel = { consoleValues: [], phases: [], completionPrompts: [], run: async () => {} };
  const fns: FnMap = {};
  if (extras.fs !== undefined) fns.fs = extras.fs;
  // Sequential result consumption keyed by spawn order, mirroring the real
  // agent() handle wait contract (wait() resolves the child's result).
  const agents: Array<{ result: unknown }> = [];
  fns.agent = async (_prompt: string, opts: { label: string }) => {
    const index = agents.length;
    agents.push({ result: results[index] ?? "ok" });
    const mine = agents[index] as { result: unknown };
    return {
      handle: `agent://${opts.label}`,
      wait: async () => {
        if (mine.result instanceof Error) throw mine.result;
        return mine.result;
      },
      cancel: async () => {},
    };
  };
  fns.wait = async () => [];
  fns.completion = async (prompt: string) => {
    kernel.completionPrompts.push(String(prompt));
    return { wait: async () => "digest-mock" };
  };
  fns.workpool = () => {
    throw new Error("workpool must not be used in fanout programs");
  };
  fns.tool = {};
  installRunner(kernel, fns);
  return kernel;
}

function lastEvalPayload(kernel: MockKernel): TaskGroupResultPayload {
  const chunks = [...kernel.consoleValues] as Array<Record<string, unknown>>;
  expect(chunks.length).toBeGreaterThan(0);
  const rawCount = chunks[0]?.chunkCount;
  expect(typeof rawCount).toBe("number");
  const count = rawCount as number;
  expect(Number.isInteger(count)).toBe(true);
  expect(count).toBeLessThanOrEqual(16);
  expect(chunks).toHaveLength(count);

  const ordered: Array<Record<string, unknown> | undefined> = new Array(count);
  for (const chunk of chunks) {
    const index = chunk.chunkIndex;
    expect(typeof index).toBe("number");
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= count) {
      throw new Error(`invalid result chunk index: ${String(index)}`);
    }
    expect(ordered[index]).toBeUndefined();
    ordered[index] = chunk;
  }

  let serialized = "";
  for (let index = 0; index < ordered.length; index++) {
    const chunk = ordered[index];
    expect(chunk).toBeDefined();
    if (chunk === undefined) throw new Error(`missing result chunk ${index}`);
    expect(chunk).toMatchObject({
      protocol: EVAL_RESULT_PROTOCOL,
      transport: EVAL_RESULT_TRANSPORT,
      chunkIndex: index,
      chunkCount: count,
    });
    const data = chunk.data;
    expect(typeof data).toBe("string");
    if (typeof data !== "string") throw new Error(`result chunk ${index} data is not text`);
    const encodedView = JSON.stringify({ kind: "json", value: chunk });
    if (encodedView === undefined) throw new Error(`result chunk ${index} is not JSON serializable`);
    expect(encodedView.length).toBeLessThanOrEqual(32 * 1024);
    serialized += data;
  }
  return JSON.parse(serialized) as TaskGroupResultPayload;
}


function byName(payload: TaskGroupResultPayload, name: string): Outcome {
  const o = payload.outcomes.find((x) => x.name === name);
  expect(o).toBeDefined();
  return o as Outcome;
}

async function runFanout(
  spec: TaskGroupSpec,
  groupId: string,
  results: Array<unknown>,
  compileOpts?: { summarize?: { model: "smol" | "default" | "slow" }; maxGroupMs?: number },
): Promise<{ kernel: MockKernel; program: string }> {
  const program = compileFanoutProgram(spec, { groupId, ...compileOpts });
  const kernel = makeKernel(results);
  await kernel.run(program);
  return { kernel, program };
}

const SPEC3 = validateSpec({
  context: "Ctx",
  tasks: [
    { name: "p0", agent: "sonic", task: "T0" },
    { name: "p1", agent: "sonic", task: "T1" },
    { name: "p2", agent: "sonic", task: "T2" },
  ],
});

describe("compiled program execution (mocked kernel)", () => {
  test("fanout all+collect returns one result containing every task outcome", async () => {
    const { kernel } = await runFanout(SPEC3, "tg-exec", ["res-0", "res-1", "res-2"]);
    const payload = lastEvalPayload(kernel);
    expect(payload.protocol).toBe(EVAL_RESULT_PROTOCOL);
    expect(payload.groupId).toBe("tg-exec");
    expect(payload.strategy).toBe("fanout");
    expect(payload.groupState).toBe("completed");
    expect(payload.rawChildChars).toBe(15); // 3 × "res-N" (5 chars each)
    expect(payload.groupError).toBeUndefined();
    expect(payload.summary).toBeUndefined();
    expect(payload.summaryError).toBeUndefined();
    // Exact top-level key set — nothing extra beyond the shared contract.
    expect(Object.keys(payload).sort()).toEqual([
      "groupId", "groupState", "outcomes", "protocol", "rawChildChars", "strategy",
    ]);
    expect(payload.outcomes).toHaveLength(3);
    for (const [i, name] of ["p0", "p1", "p2"].entries()) {
      const o = byName(payload, name);
      expect(o.agent).toBe("sonic");
      expect(o.status).toBe("succeeded");
      expect(o.result).toBe(`res-${i}`);
      expect(o.handle).toBe(`agent://tg-exec-${name}`);
      expect(typeof o.durationMs).toBe("number");
      expect(o.structured).toBeUndefined();
      expect(o.error).toBeUndefined();
      expect(o.resolvedModel).toBeUndefined();
      expect(Object.keys(o).sort()).toEqual([
        "agent", "durationMs", "handle", "name", "result", "status",
      ]);
    }
    // Phase() carried the coarse native status: one running + one settle each.
    expect(kernel.phases.filter((p) => p.endsWith("running"))).toHaveLength(3);
    expect(kernel.phases.filter((p) => p.endsWith("succeeded"))).toHaveLength(3);
  });

  test("Fanout treats rejected strings and undefined rejections as failures", async () => {
    const spec = validateSpec({
      context: "Ctx",
      failure: { mode: "collect" },
      tasks: [
        { name: "spawn-rejected", agent: "sonic", task: "Spawn reject" },
        { name: "wait-rejected", agent: "sonic", task: "Wait reject" },
        { name: "undefined-result", agent: "sonic", task: "Resolve undefined" },
      ],
    });
    const kernel: MockKernel = { consoleValues: [], phases: [], completionPrompts: [], run: async () => {} };
    let calls = 0;
    installRunner(kernel, {
      agent: async (_prompt: string, opts: { label: string }) => {
        const index = calls++;
        if (index === 0) throw undefined;
        return {
          handle: `agent://${opts.label}`,
          wait: async () => {
            if (index === 1) throw "string rejection";
            return undefined;
          },
          status: async () => "failed",
          cancel: async () => {},
        };
      },
      wait: async () => [],
      completion: async () => ({ wait: async () => "digest" }),
      workpool: async () => {
        throw new Error("not a pool test");
      },
      tool: {},
    });
    await kernel.run(compileFanoutProgram(spec, { groupId: "tg-rejected-values" }));
    const payload = lastEvalPayload(kernel);

    expect(payload.groupState).toBe("completed");
    expect(payload.outcomes).toHaveLength(3);
    expect(byName(payload, "spawn-rejected")).toMatchObject({
      status: "failed",
      error: "agent promise rejected without an error value",
    });
    expect(byName(payload, "wait-rejected").status).toBe("failed");
    expect(byName(payload, "wait-rejected").error).toContain("string rejection");
    expect(byName(payload, "undefined-result")).toMatchObject({ status: "succeeded" });
    expect(byName(payload, "undefined-result").result).toBeUndefined();
    expect(byName(payload, "undefined-result").structured).toBeUndefined();
  });

  test("Fanout cancels and reaps a handle when its first wait fails while running", async () => {
    const spec = validateSpec({
      context: "Ctx",
      failure: { mode: "collect" },
      tasks: [
        { name: "transient", agent: "sonic", task: "Transient wait failure" },
        { name: "normal", agent: "sonic", task: "Normal result" },
      ],
    });
    const kernel: MockKernel = { consoleValues: [], phases: [], completionPrompts: [], run: async () => {} };
    let calls = 0;
    let waitCalls = 0;
    let statusCalls = 0;
    let cancelCalls = 0;
    installRunner(kernel, {
      agent: async (_prompt: string, opts: { label: string }) => {
        const index = calls++;
        return {
          handle: `agent://${opts.label}`,
          wait: async () => {
            waitCalls++;
            if (index === 0 && waitCalls === 1) throw new Error("temporary wait failure");
            return index === 0 ? new Error("cancelled by Task Group") : "normal result";
          },
          status: async () => (statusCalls++ === 0 ? "running" : "cancelled"),
          cancel: async () => {
            cancelCalls++;
            return true;
          },
        };
      },
      wait: async () => [],
      completion: async () => ({ wait: async () => "digest" }),
      workpool: async () => {
        throw new Error("not a pool test");
      },
      tool: {},
    });
    await kernel.run(compileFanoutProgram(spec, { groupId: "tg-wait-reap" }));
    const payload = lastEvalPayload(kernel);

    expect(payload.groupState).toBe("completed");
    expect(payload.outcomes).toHaveLength(2);
    expect(byName(payload, "transient")).toMatchObject({
      status: "cancelled",
      error: "cancelled by Task Group",
    });
    expect(byName(payload, "normal")).toMatchObject({ status: "succeeded", result: "normal result" });
    expect(waitCalls).toBe(3);
    expect(statusCalls).toBe(1);
    expect(cancelCalls).toBe(1);
  });

  test("structured child values ride inline in outcomes", async () => {
    const obj = { verdict: "ok", scores: [1, 2, 3] };
    const { kernel } = await runFanout(SPEC3, "tg-str", [obj, "text-1", "text-2"]);
    const payload = lastEvalPayload(kernel);
    expect(payload.groupState).toBe("completed");
    const o = byName(payload, "p0");
    expect(o.status).toBe("succeeded");
    expect(o.structured).toEqual(obj);
    expect(o.result).toBeUndefined();
    expect(byName(payload, "p1").result).toBe("text-1");
    expect(payload.rawChildChars).toBe(JSON.stringify(obj).length + 6 + 6);
  });

  test("per-task output is clipped to output.perTaskChars", async () => {
    const spec = validateSpec({
      context: "Ctx",
      output: { mode: "compact", perTaskChars: 100, maxTotalChars: 500, preserveHandles: true },
      tasks: [
        { name: "big-string", agent: "sonic", task: "S" },
        { name: "big-object", agent: "sonic", task: "O" },
      ],
    });
    const huge = { payload: "z".repeat(300) };
    const { kernel } = await runFanout(spec, "tg-clip", ["x".repeat(400), huge]);
    const payload = lastEvalPayload(kernel);
    const s = byName(payload, "big-string");
    expect(s.status).toBe("succeeded");
    expect(s.result?.startsWith("x".repeat(100))).toBe(true);
    expect(s.result?.endsWith("chars truncated]")).toBe(true);
    const o = byName(payload, "big-object");
    expect(o.status).toBe("succeeded");
    expect(o.result?.startsWith('{"payload":"')).toBe(true);
    expect(o.result?.endsWith("chars truncated]")).toBe(true);
    expect(o.structured).toBeUndefined();
    // rawChildChars still counts the FULL pre-clip child output.
    expect(payload.rawChildChars).toBe(400 + JSON.stringify(huge).length);
  });

  test("fanout any-join cancels losers (reaped via wait) and still finalizes", async () => {
    const spec = validateSpec({
      context: "Ctx",
      join: { mode: "any" },
      tasks: [
        { name: "fast", agent: "sonic", task: "F" },
        { name: "slow", agent: "sonic", task: "S" },
      ],
    });
    const program = compileFanoutProgram(spec, { groupId: "tg-any" });
    const kernel: MockKernel = { consoleValues: [], phases: [], completionPrompts: [], run: async () => {} };
    const cancelled: string[] = [];
    let slowResolve: ((value: unknown) => void) | undefined;
    const agent = async (_p: string, opts: { label: string }) => ({
      handle: `agent://${opts.label}`,
      // Fast child settles immediately; slow stays pending until cancelled.
      wait: () =>
        opts.label.endsWith("fast")
          ? Promise.resolve("first!")
          : new Promise<unknown>((resolve) => {
              slowResolve = resolve;
            }),
      cancel: async () => {
        cancelled.push(opts.label);
        // Mirror the native handle: cancelling settles the pending wait.
        slowResolve?.(new Error("cancelled: aborted by group exit"));
      },
    });
    const fns: FnMap = {
      agent,
      wait: async () => [],
      completion: async () => ({ wait: async () => "d" }),
      workpool: () => {
        throw new Error("no pool in fanout");
      },
      tool: {},
    };
    installRunner(kernel, fns);
    await kernel.run(program);
    const payload = lastEvalPayload(kernel);
    expect(payload.groupState).toBe("completed");
    expect(payload.outcomes).toHaveLength(2);
    const fast = byName(payload, "fast");
    expect(fast.status).toBe("succeeded");
    expect(fast.result).toBe("first!");
    const slow = byName(payload, "slow");
    expect(slow.status).toBe("cancelled");
    expect(slow.error).toBe("cancelled: aborted by group exit");
    expect(cancelled.some((l) => l.endsWith("slow"))).toBe(true);
  });
  test("fail_fast records pending and never-started tasks exactly once", async () => {
    const spec = validateSpec({
      context: "Ctx",
      join: { mode: "all" },
      failure: { mode: "fail_fast" },
      execution: { strategy: "fanout", concurrency: 2 },
      tasks: [
        { name: "ff0", agent: "sonic", task: "T0" },
        { name: "ff1", agent: "sonic", task: "T1" },
        { name: "ff2", agent: "sonic", task: "T2" },
        { name: "ff3", agent: "sonic", task: "T3" },
      ],
    });
    const kernel: MockKernel = { consoleValues: [], phases: [], completionPrompts: [], run: async () => {} };
    let spawned = 0;
    let cancelPending: (() => void) | undefined;
    const cancelled: string[] = [];
    const agent = async (_prompt: string, opts: { label: string }) => {
      spawned++;
      return {
        handle: `agent://${opts.label}`,
        wait: () =>
          opts.label.endsWith("-ff0")
            ? Promise.reject(new Error("fatal child failure"))
            : new Promise((resolve) => {
                cancelPending = () => resolve(new Error("cancelled by group"));
              }),
        status: async () => (opts.label.endsWith("-ff0") ? "failed" : "cancelled"),
        cancel: async () => {
          cancelled.push(opts.label);
          cancelPending?.();
          return true;
        },
      };
    };
    const fns: FnMap = { agent, wait: async () => [], completion: async () => ({ wait: async () => "d" }) };
    installRunner(kernel, fns);
    await kernel.run(compileFanoutProgram(spec, { groupId: "tg-ff" }));
    const payload = lastEvalPayload(kernel);

    expect(payload.groupState).toBe("failed");
    expect(spawned).toBe(2);
    expect(payload.outcomes).toHaveLength(4);
    expect(new Set(payload.outcomes.map((outcome) => outcome.name)).size).toBe(4);
    expect(byName(payload, "ff0").status).toBe("failed");
    expect(byName(payload, "ff1").status).toBe("cancelled");
    expect(byName(payload, "ff2")).toMatchObject({ status: "cancelled", error: expect.any(String) });
    expect(byName(payload, "ff3")).toMatchObject({ status: "cancelled", error: expect.any(String) });
    expect(cancelled).toEqual(["tg-ff-ff1"]);
  });

  test("synchronous handle.wait errors become task outcomes", async () => {
    const fns: FnMap = {
      agent: async (_prompt: string, opts: { label: string }) => ({
        handle: `agent://${opts.label}`,
        wait: () => {
          throw new Error("synchronous wait failure");
        },
        status: async () => "failed",
        cancel: async () => false,
      }),
      wait: async () => [],
      completion: async () => ({ wait: async () => "d" }),
    };
    const kernel = makeKernel([]);
    Object.assign(fns, { console: undefined, phase: undefined });
    installRunner(kernel, fns);

    let thrown: unknown;
    try {
      await kernel.run(compileFanoutProgram(SPEC3, { groupId: "tg-sync-wait" }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeUndefined();
    const payload = lastEvalPayload(kernel);
    expect(payload.groupState).toBe("failed");
    expect(payload.outcomes).toHaveLength(3);
    for (const outcome of payload.outcomes) {
      expect(outcome.status).toBe("failed");
      expect(outcome.error).toContain("synchronous wait failure");
    }
  });

  test("maxGroupMs cancels and reaps every pending fanout handle", async () => {
    vi.useFakeTimers();
    try {
      const kernel: MockKernel = { consoleValues: [], phases: [], completionPrompts: [], run: async () => {} };
      const cancelled: string[] = [];
      let started = 0;
      const fns: FnMap = {
        agent: async (_prompt: string, opts: { label: string }) => {
          const gate = Promise.withResolvers<unknown>();
          return {
            handle: `agent://${opts.label}`,
            wait: () => {
              started++;
              return gate.promise;
            },
            status: async () => (cancelled.includes(opts.label) ? "cancelled" : "running"),
            cancel: async () => {
              cancelled.push(opts.label);
              gate.resolve(new Error("cancelled by timeout"));
              return true;
            },
          };
        },
        wait: async () => [],
        completion: async () => ({ wait: async () => "d" }),
      };
      installRunner(kernel, fns);
      const run = kernel.run(compileFanoutProgram(SPEC3, { groupId: "tg-timeout", maxGroupMs: 10 }));
      for (let index = 0; index < 20 && started < 3; index++) await Promise.resolve();
      expect(started).toBe(3);
      vi.advanceTimersByTime(10);
      await run;
      const payload = lastEvalPayload(kernel);
      expect(payload.groupState).toBe("failed");
      expect(payload.groupError).toContain("maxGroupMs");
      expect(payload.outcomes).toHaveLength(3);
      expect(payload.outcomes.every((outcome) => outcome.status === "cancelled")).toBe(true);
      expect(cancelled).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("Fanout does not spawn queued tasks after the group deadline", async () => {
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      const spec = validateSpec({
        context: "Ctx",
        execution: { strategy: "fanout", concurrency: 1 },
        tasks: [
          { name: "deadline-first", agent: "sonic", task: "First" },
          { name: "deadline-queued-1", agent: "sonic", task: "Queued 1" },
          { name: "deadline-queued-2", agent: "sonic", task: "Queued 2" },
        ],
      });
      const kernel: MockKernel = { consoleValues: [], phases: [], completionPrompts: [], run: async () => {} };
      let agentCalls = 0;
      installRunner(kernel, {
        agent: async (_prompt: string, opts: { label: string }) => {
          agentCalls++;
          return {
            handle: `agent://${opts.label}`,
            wait: async () => {
              clock += 20;
              return "first task";
            },
            cancel: async () => true,
          };
        },
        wait: async () => [],
        completion: async () => ({ wait: async () => "digest" }),
        workpool: async () => {
          throw new Error("not a Pool test");
        },
        tool: {},
      });
      await kernel.run(compileFanoutProgram(spec, { groupId: "tg-deadline-spawn", maxGroupMs: 10 }));
      const payload = lastEvalPayload(kernel);

      expect(agentCalls).toBe(1);
      expect(payload.groupState).toBe("failed");
      expect(payload.groupError).toContain("maxGroupMs");
      expect(payload.outcomes).toHaveLength(3);
      expect(byName(payload, "deadline-first").status).toBe("succeeded");
      expect(byName(payload, "deadline-queued-1").status).toBe("cancelled");
      expect(byName(payload, "deadline-queued-2").status).toBe("cancelled");
    } finally {
      Date.now = realNow;
    }
  });


  test("Fanout AgentHandle timeouts use OMP seconds while respecting the millisecond group deadline", async () => {
    vi.useFakeTimers();
    try {
      const spec = validateSpec({
        context: "Ctx",
        failure: { mode: "collect" },
        tasks: [
          { name: "timeout-unit-a", agent: "sonic", task: "A" },
          { name: "timeout-unit-b", agent: "sonic", task: "B" },
        ],
      });
      const kernel: MockKernel = { consoleValues: [], phases: [], completionPrompts: [], run: async () => {} };
      const waitTimeouts: number[] = [];
      const pending = new Map<string, { resolve: (value: unknown) => void; cancelTimer: () => void }>();
      const cancelled = new Set<string>();
      installRunner(kernel, {
        agent: async (_prompt: string, opts: { label: string }) => ({
          handle: `agent://${opts.label}`,
          wait: ({ timeout }: { timeout: number }) => {
            waitTimeouts.push(timeout);
            if (cancelled.has(opts.label)) return Promise.resolve(new Error("cancelled"));
            return new Promise((resolve) => {
              const timer = setTimeout(() => resolve("done"), Math.max(1, timeout * 1000 - 1));
              pending.set(opts.label, { resolve, cancelTimer: () => clearTimeout(timer) });
            });
          },
          status: async () => (cancelled.has(opts.label) ? "cancelled" : "running"),
          cancel: async () => {
            cancelled.add(opts.label);
            const entry = pending.get(opts.label);
            if (entry) {
              entry.cancelTimer();
              entry.resolve(new Error("cancelled"));
            }
            return true;
          },
        }),
        wait: async () => [],
        completion: async () => ({ wait: async () => "digest" }),
        workpool: async () => {
          throw new Error("not a Pool test");
        },
        tool: {},
      });
      const run = kernel.run(compileFanoutProgram(spec, { groupId: "tg-wait-timeout-unit", maxGroupMs: 1000 }));
      for (let i = 0; i < 30 && waitTimeouts.length < 2; i++) await Promise.resolve();
      expect(waitTimeouts).toHaveLength(2);
      vi.advanceTimersByTime(999);
      await run;
      const payload = lastEvalPayload(kernel);

      expect(payload.groupState).toBe("completed");
      expect(payload.outcomes.every((outcome) => outcome.status === "succeeded")).toBe(true);
      expect(waitTimeouts.every((timeout) => timeout > 0 && timeout <= 1)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("Fanout cancellation reaper honors bounded OMP-second waits", async () => {
    vi.useFakeTimers();
    try {
      const spec = validateSpec({
        context: "Ctx",
        execution: { strategy: "fanout", concurrency: 1 },
        failure: { mode: "collect" },
        tasks: [
          { name: "reap-first", agent: "sonic", task: "First" },
          { name: "reap-second", agent: "sonic", task: "Second" },
        ],
      });
      const kernel: MockKernel = { consoleValues: [], phases: [], completionPrompts: [], run: async () => {} };
      let firstWaitCalls = 0;
      let reapWaitCalls = 0;
      let cancelCalls = 0;
      let cancelled = false;
      installRunner(kernel, {
        agent: async (_prompt: string, opts: { label: string }) => {
          if (opts.label.endsWith("-reap-second")) {
            return {
              handle: `agent://${opts.label}`,
              wait: async () => "second result",
              cancel: async () => false,
            };
          }
          return {
            handle: `agent://${opts.label}`,
            wait: ({ timeout }: { timeout: number }) => {
              firstWaitCalls++;
              if (firstWaitCalls === 1) throw new Error("transient wait failure");
              reapWaitCalls++;
              return new Promise((_resolve, reject) => {
                setTimeout(() => reject(new Error("reaper wait timed out")), timeout * 1000);
              });
            },
            status: async () => (cancelled ? "cancelled" : "running"),
            cancel: async () => {
              cancelCalls++;
              cancelled = true;
              return true;
            },
          };
        },
        wait: async () => [],
        completion: async () => ({ wait: async () => "digest" }),
        workpool: async () => {
          throw new Error("not a Pool test");
        },
        tool: {},
      });
      const run = kernel.run(compileFanoutProgram(spec, { groupId: "tg-reaper-units", maxGroupMs: 60_000 }));
      for (let spin = 0; spin < 100 && reapWaitCalls < 1; spin++) await Promise.resolve();
      for (let attempt = 1; attempt <= 3; attempt++) {
        for (let spin = 0; spin < 100 && reapWaitCalls < attempt; spin++) await Promise.resolve();
        expect(reapWaitCalls).toBe(attempt);
        vi.advanceTimersByTime(10_000);
        for (let spin = 0; spin < 100; spin++) await Promise.resolve();
      }
      await run;
      const payload = lastEvalPayload(kernel);

      expect(firstWaitCalls).toBe(4);
      expect(cancelCalls).toBe(1);
      expect(payload.groupState).toBe("completed");
      expect(byName(payload, "reap-first").status).toBe("cancelled");
      expect(byName(payload, "reap-first").error).toContain("could not be reaped");
      expect(byName(payload, "reap-second")).toMatchObject({ status: "succeeded", result: "second result" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("failures classify as failed/cancelled with errors, group completes (collect)", async () => {
    const { kernel } = await runFanout(SPEC3, "tg-fail", ["fine", new Error("boom-1"), new Error("cancel: interrupted")]);
    const payload = lastEvalPayload(kernel);
    expect(payload.groupState).toBe("completed"); // collect: ≥1 success
    expect(byName(payload, "p0").status).toBe("succeeded");
    const failed = byName(payload, "p1");
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("boom-1");
    expect(failed.result).toBeUndefined();
    const cancelled = byName(payload, "p2");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.error).toContain("cancel: interrupted");
    expect(payload.rawChildChars).toBe(4); // only "fine" succeeded
  });
  test("all+collect reports a failed group when every child fails", async () => {
    const { kernel } = await runFanout(SPEC3, "tg-all-failed", [
      new Error("failure-0"),
      new Error("failure-1"),
      new Error("failure-2"),
    ]);
    const payload = lastEvalPayload(kernel);
    expect(payload.groupState).toBe("failed");
    expect(payload.outcomes).toHaveLength(3);
    expect(new Set(payload.outcomes.map((outcome) => outcome.name)).size).toBe(3);
    expect(payload.outcomes.every((outcome) => outcome.status === "failed")).toBe(true);
  });

  test("quorum stops after the threshold and records cancelled losers", async () => {
    const spec = validateSpec({
      context: "Ctx",
      join: { mode: "quorum", quorum: 2 },
      tasks: [
        { name: "q0", agent: "sonic", task: "Q0" },
        { name: "q1", agent: "sonic", task: "Q1" },
        { name: "q2", agent: "sonic", task: "Q2" },
      ],
    });
    const kernel: MockKernel = { consoleValues: [], phases: [], completionPrompts: [], run: async () => {} };
    const slow = Promise.withResolvers<unknown>();
    const cancelled: string[] = [];
    const agent = async (_prompt: string, opts: { label: string }) => ({
      handle: `agent://${opts.label}`,
      wait: () => opts.label.endsWith("-q2") ? slow.promise : Promise.resolve("success:" + opts.label),
      status: async () => (cancelled.includes(opts.label) ? "cancelled" : "running"),
      cancel: async () => {
        cancelled.push(opts.label);
        slow.resolve(new Error("cancelled after quorum"));
        return true;
      },
    });
    installRunner(kernel, { agent, wait: async () => [], completion: async () => ({ wait: async () => "d" }) });
    await kernel.run(compileFanoutProgram(spec, { groupId: "tg-quorum" }));
    const payload = lastEvalPayload(kernel);

    expect(payload.groupState).toBe("completed");
    expect(payload.outcomes).toHaveLength(3);
    expect(payload.outcomes.filter((outcome) => outcome.status === "succeeded")).toHaveLength(2);
    expect(byName(payload, "q2").status).toBe("cancelled");
    expect(cancelled).toEqual(["tg-quorum-q2"]);
  });

  test("fanout never exceeds the requested concurrency and refills slots", async () => {
    const spec = validateSpec({
      context: "Ctx",
      execution: { strategy: "fanout", concurrency: 2 },
      tasks: Array.from({ length: 5 }, (_, i) => ({ name: `c${i}`, agent: "sonic", task: `C${i}` })),
    });
    const kernel: MockKernel = { consoleValues: [], phases: [], completionPrompts: [], run: async () => {} };
    let active = 0;
    let maximumActive = 0;
    let spawned = 0;
    const pending: Array<{ label: string; resolve(value: unknown): void }> = [];
    const agent = async (_prompt: string, opts: { label: string }) => {
      spawned++;
      return {
        handle: `agent://${opts.label}`,
        wait: () => {
          active++;
          maximumActive = Math.max(maximumActive, active);
          const gate = Promise.withResolvers<unknown>();
          pending.push({ label: opts.label, resolve: gate.resolve });
          return gate.promise.finally(() => {
            active--;
          });
        },
        cancel: async () => false,
      };
    };
    installRunner(kernel, { agent, wait: async () => [], completion: async () => ({ wait: async () => "d" }) });
    const run = kernel.run(compileFanoutProgram(spec, { groupId: "tg-concurrency" }));
    for (let index = 0; index < 5; index++) {
      for (let attempt = 0; pending.length === 0 && attempt < 100; attempt++) await Promise.resolve();
      expect(pending.length).toBeGreaterThan(0);
      const next = pending.shift();
      if (!next) throw new Error("expected a pending fanout handle");
      next.resolve("result:" + next.label);
    }
    await run;
    const payload = lastEvalPayload(kernel);

    expect(maximumActive).toBeLessThanOrEqual(2);
    expect(spawned).toBe(5);
    expect(payload.outcomes).toHaveLength(5);
    expect(payload.outcomes.every((outcome) => outcome.status === "succeeded")).toBe(true);
  });

  test("summarize mode runs completion() over inline results and reports summary", async () => {
    const spec = validateSpec({
      ...SPEC3,
      output: { mode: "summarize", perTaskChars: 1200, maxTotalChars: 4000, preserveHandles: true },
    } as unknown as Record<string, unknown>);
    const { kernel } = await runFanout(spec, "tg-sum", ["alpha-res", "beta-res", "gamma-res"], {
      summarize: { model: "smol" },
    });
    const payload = lastEvalPayload(kernel);
    expect(payload.summary).toBe("digest-mock");
    expect(payload.summaryError).toBeUndefined();
    expect(kernel.phases).toContain("summarizing");
    // Corpus is fed by the inline per-task results (no side channel).
    expect(kernel.completionPrompts).toHaveLength(1);
    expect(kernel.completionPrompts[0]).toContain("alpha-res");
    expect(kernel.completionPrompts[0]).toContain("gamma-res");
  });

  test("pool recovers each item from the public peek batch output", async () => {
    const spec = validateSpec({
      context: "Ctx",
      join: { mode: "all" },
      output: { mode: "summarize" },
      tasks: Array.from({ length: 6 }, (_, i) => ({ name: `w${i}`, agent: "sonic", task: `W${i}` })),
    });
    const program = compilePoolProgram(spec, { groupId: "tg-pool", summarize: { model: "smol" } });
    const kernel: MockKernel = { consoleValues: [], phases: [], completionPrompts: [], run: async () => {} };
    const ids = Array.from({ length: 6 }, (_, i) => `tg-pool#${i + 1}`);
    const values: unknown[] = [
      "pool-res-0",
      { verdict: "ok", score: 9, error: "business field" },
      undefined,
      "```json\n{\"fenced\":true}\n```",
      null,
      { stdout: "captured output", wallTime: "5 seconds", files: ["child.started"] },
    ];
    const encoded = (i: number): Record<string, unknown> =>
      i === 2
        ? { error: "worker rejected item" }
        : { status: "succeeded", value: values[i] };
    const firstOutput = JSON.stringify({
      [ids[0] as string]: JSON.stringify(encoded(0)),
      [ids[1] as string]: encoded(1),
      [ids[2] as string]: encoded(2),
    }, null, 2);
    const secondOutput = JSON.stringify({
      [ids[3] as string]: encoded(3),
      [ids[4] as string]: encoded(4),
      [ids[5] as string]: values[5],
    }, null, 2);
    let pushed = false;
    let settled = false;
    let waitCalls = 0;
    const pool = {
      push: (...items: string[]) => {
        expect(items).toHaveLength(6);
        pushed = true;
        return ids;
      },
      status: async () => ({
        name: "tg-pool",
        agent: "sonic",
        limit: 2,
        closed: settled,
        freshAgents: false,
        agents: [],
        items: !pushed
          ? { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 }
          : settled
            ? { queued: 0, running: 0, completed: 5, failed: 1, cancelled: 0 }
            : { queued: 3, running: 3, completed: 0, failed: 0, cancelled: 0 },
        batches: !pushed ? 0 : settled ? 2 : 1,
      }),
      peek: async () => ({
        batches: !pushed
          ? []
          : settled
            ? [
                { id: "worker-a-b1", agent: "worker-a", items: ids.slice(0, 3), status: "completed", output: firstOutput },
                { id: "worker-b-b1", agent: "worker-b", items: ids.slice(3), status: "completed", output: secondOutput },
              ]
            : [
                { id: "worker-a-b1", agent: "worker-a", items: ids.slice(0, 3), status: "completed", output: firstOutput },
              ],
        pending: !pushed ? 0 : settled ? 0 : 3,
      }),
      close: async () => ({ dropped: [] as string[] }),
    };
    const poolOptions: Array<{ agent: string; options: Record<string, unknown> }> = [];
    const waitResults = [
      { details: { op: "wait", jobs: [] } },
      { details: { op: "wait", jobs: [{ id: "tg-pool", status: "running" }, { id: "worker-a-b1", status: "completed" }] } },
      { details: { op: "wait", jobs: [{ id: "tg-pool", status: "completed" }, { id: "worker-b-b1", status: "completed" }] } },
    ];
    const tool = Object.assign(async () => ({}), {
      read: async ({ path }: { path: string }) => {
        expect(path).toBe("proc://");
        return { details: { proc: { jobs: [], agents: [], daemons: [] } } };
      },
      wait: async () => {
        const result = waitResults[Math.min(waitCalls, waitResults.length - 1)];
        waitCalls++;
        if (waitCalls === 3) settled = true;
        return result;
      },
      write: async () => ({ content: [{ type: "text", text: "cancelled" }] }),
    });
    const fns: FnMap = {
      agent: async () => {
        throw new Error("no agent in pool");
      },
      wait: async () => [],
      completion: async (prompt: string) => {
        kernel.completionPrompts.push(prompt);
        return { wait: async () => "digest-mock" };
      },
      workpool: async (agent: string, options: Record<string, unknown>) => {
        poolOptions.push({ agent, options });
        return pool;
      },
      tool,
    };
    installRunner(kernel, fns);
    await kernel.run(program);
    const payload = lastEvalPayload(kernel);

    expect(payload.strategy).toBe("pool");
    expect(payload.groupState).toBe("completed");
    expect(payload.outcomes).toHaveLength(6);
    expect(waitCalls).toBe(3);
    expect(poolOptions).toEqual([{ agent: "sonic", options: { name: "tg-pool", context: "Ctx" } }]);
    expect(byName(payload, "w0")).toMatchObject({ status: "succeeded", result: "pool-res-0", handle: "agent://worker-a" });
    expect(byName(payload, "w1")).toMatchObject({ status: "succeeded", structured: { verdict: "ok", score: 9, error: "business field" }, handle: "agent://worker-a" });
    expect(byName(payload, "w2")).toMatchObject({ status: "failed", error: "worker rejected item", handle: "agent://worker-a" });
    expect(byName(payload, "w3")).toMatchObject({ status: "succeeded", result: "```json\n{\"fenced\":true}\n```", handle: "agent://worker-b" });
    expect(byName(payload, "w4")).toMatchObject({ status: "succeeded", structured: null, handle: "agent://worker-b" });
    expect(byName(payload, "w5")).toMatchObject({
      status: "succeeded",
      structured: { stdout: "captured output", wallTime: "5 seconds", files: ["child.started"] },
      handle: "agent://worker-b",
    });
    for (const outcome of payload.outcomes) {
      expect(outcome.durationMs).toBeUndefined();
      expect(outcome.resolvedModel).toBeUndefined();
    }
    expect(payload.rawChildChars).toBe(
      "pool-res-0".length +
        JSON.stringify(values[1]).length +
        "```json\n{\"fenced\":true}\n```".length +
        JSON.stringify(null).length +
        JSON.stringify(values[5]).length,
    );
    expect(payload.summary).toBe("digest-mock");
    expect(kernel.completionPrompts).toHaveLength(1);
  });

  test("Pool preserves peer messages with the public Wait result shape during service wakes", async () => {
    const spec = validateSpec({
      context: "Ctx",
      join: { mode: "all" },
      tasks: [
        { name: "service-a", agent: "sonic", task: "A" },
        { name: "service-b", agent: "sonic", task: "B" },
      ],
    });
    const groupId = "tg-live-service";
    const ids = [`${groupId}#1`, `${groupId}#2`];
    const output = JSON.stringify({
      [ids[0] as string]: { status: "succeeded", value: "A" },
      [ids[1] as string]: { status: "succeeded", value: "B" },
    });
    let pushed = false;
    let waitCalls = 0;
    const pool = {
      push: (...items: string[]) => {
        expect(waitCalls).toBe(0);
        pushed = true;
        expect(items).toHaveLength(2);
        return ids;
      },
      status: async () => ({
        name: groupId,
        agent: "sonic",
        limit: 2,
        closed: pushed && waitCalls >= 2,
        freshAgents: false,
        agents: [],
        items: pushed
          ? { queued: 0, running: 0, completed: 2, failed: 0, cancelled: 0 }
          : { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 },
        batches: pushed ? 1 : 0,
      }),
      peek: async () => ({
        batches: pushed
          ? [{ id: "worker-service-b1", agent: "worker-service", items: ids, status: "completed", output }]
          : [],
        pending: 0,
      }),
      close: async () => ({ dropped: [] as string[] }),
    };
    const tool = Object.assign(async () => ({}), {
      read: async ({ path }: { path: string }) => {
        expect(path).toBe("proc://");
        return {
          details: {
            proc: {
              jobs: pushed
                ? [{ id: groupId, status: "running" }, { id: "worker-service-b1", status: "running" }]
                : [],
              agents: [],
              daemons: [{ id: "live-service" }],
            },
          },
        };
      },
      wait: async () => {
        waitCalls++;
        if (waitCalls === 1) {
          return {
            text: "[peer-message] helper: independent update",
            details: { op: "wait", from: "parent", waited: { id: "peer-message", from: "helper", body: "independent update" } },
          };
        }
        return {
          details: {
            op: "wait",
            jobs: [{ id: groupId, status: "completed" }, { id: "worker-service-b1", status: "completed" }],
          },
        };
      },
      write: async () => {
        throw new Error("successful Pool must not cancel jobs");
      },
    });
    const kernel: MockKernel = { consoleValues: [], phases: [], completionPrompts: [], run: async () => {} };
    let agentCalls = 0;
    installRunner(kernel, {
      agent: async () => {
        agentCalls++;
        throw new Error("a live service must not force Fanout");
      },
      wait: async () => [],
      completion: async () => ({ wait: async () => "digest" }),
      workpool: async (_agent: string, options: Record<string, unknown>) => {
        expect(options).toEqual({ name: groupId, context: "Ctx" });
        return pool;
      },
      tool,
    });
    await kernel.run(compilePoolProgram(spec, { groupId }));
    const payload = lastEvalPayload(kernel);

    expect(payload.strategy).toBe("pool");
    expect(payload.groupState).toBe("failed");
    expect(payload.groupError).toContain("peer message consumed while joining Pool");
    expect(payload.groupError).toContain("independent update");
    expect(payload.outcomes).toHaveLength(2);
    expect(byName(payload, "service-a").status).toBe("succeeded");
    expect(byName(payload, "service-b").status).toBe("succeeded");
    expect(waitCalls).toBe(2);
    expect(agentCalls).toBe(0);
  });

  test("pool falls back before creation when another owned job can win wait()", async () => {
    const spec = validateSpec({
      context: "Ctx",
      tasks: Array.from({ length: 6 }, (_, i) => ({ name: `f${i}`, agent: "sonic", task: `F${i}` })),
    });
    const program = compilePoolProgram(spec, { groupId: "tg-busy" });
    const kernel: MockKernel = { consoleValues: [], phases: [], completionPrompts: [], run: async () => {} };
    const fns: FnMap = {};
    let workpoolCalls = 0;
    fns.agent = async (_prompt: string, opts: { label: string }) => ({
      handle: `agent://${opts.label}`,
      wait: async () => `result:${opts.label}`,
      cancel: async () => {},
    });
    fns.wait = async () => [];
    fns.completion = async () => ({ wait: async () => "digest" });
    fns.workpool = async () => {
      workpoolCalls++;
      throw new Error("must not start a pool beside another job");
    };
    fns.tool = Object.assign(async () => ({}), {
      read: async () => ({
        details: { proc: { jobs: [{ id: "other-job", status: "running" }], agents: [], daemons: [] } },
      }),
    });
    installRunner(kernel, fns);
    await kernel.run(program);
    const payload = lastEvalPayload(kernel);
    expect(payload.strategy).toBe("fanout");
    expect(payload.outcomes).toHaveLength(6);
    expect(payload.fallbackReason).toContain("other-job");
    expect(workpoolCalls).toBe(0);
  });
  test("Pool preflight preserves a consumed peer message before falling back", async () => {
    const spec = validateSpec({
      context: "Ctx",
      tasks: Array.from({ length: 6 }, (_, i) => ({ name: `pm${i}`, agent: "sonic", task: `PM${i}` })),
    });
    const groupId = "tg-peer-preflight";
    const kernel: MockKernel = { consoleValues: [], phases: [], completionPrompts: [], run: async () => {} };
    let waitCalls = 0;
    let workpoolCalls = 0;
    const fns: FnMap = {
      agent: async (_prompt: string, opts: { label: string }) => ({
        handle: `agent://${opts.label}`,
        wait: async () => `result:${opts.label}`,
        cancel: async () => {},
      }),
      wait: async () => [],
      completion: async () => ({ wait: async () => "digest" }),
      workpool: async () => {
        workpoolCalls++;
        throw new Error("preflight message must prevent Pool creation");
      },
      tool: Object.assign(async () => ({}), {
        read: async () => ({ details: { proc: { jobs: [], agents: [], daemons: [] } } }),
        wait: async () => {
          waitCalls++;
          return {
            text: "[peer-7] helper: please check the new input",
            details: {
              op: "wait",
              from: "main",
              waited: { id: "peer-7", from: "helper", body: "please check the new input" },
            },
          };
        },
      }),
    };
    installRunner(kernel, fns);
    await kernel.run(compilePoolProgram(spec, { groupId }));
    const payload = lastEvalPayload(kernel);

    expect(payload.strategy).toBe("fanout");
    expect(payload.fallbackReason).toContain("please check the new input");
    expect(payload.outcomes).toHaveLength(6);
    expect(payload.outcomes.every((outcome) => outcome.status === "succeeded")).toBe(true);
    expect(waitCalls).toBe(1);
    expect(workpoolCalls).toBe(0);
  });
  test("Pool falls back when proc inventory reports unavailable services", async () => {
    const spec = validateSpec({
      context: "Ctx",
      tasks: Array.from({ length: 6 }, (_, i) => ({ name: `svc${i}`, agent: "sonic", task: `SVC${i}` })),
    });
    const groupId = "tg-services-unavailable";
    const kernel: MockKernel = { consoleValues: [], phases: [], completionPrompts: [], run: async () => {} };
    let waitCalls = 0;
    let workpoolCalls = 0;
    installRunner(kernel, {
      agent: async (_prompt: string, opts: { label: string }) => ({
        handle: `agent://${opts.label}`,
        wait: async () => `result:${opts.label}`,
        cancel: async () => {},
      }),
      wait: async () => [],
      completion: async () => ({ wait: async () => "digest" }),
      workpool: async () => {
        workpoolCalls++;
        throw new Error("unverifiable proc inventory must not start Pool");
      },
      tool: Object.assign(async () => ({}), {
        read: async () => ({
          text: "Services unavailable",
          details: { proc: { jobs: [], agents: [], daemons: [] } },
        }),
        wait: async () => {
          waitCalls++;
          return { details: { op: "wait", jobs: [] } };
        },
      }),
    });
    await kernel.run(compilePoolProgram(spec, { groupId }));
    const payload = lastEvalPayload(kernel);

    expect(payload.strategy).toBe("fanout");
    expect(payload.fallbackReason).toContain("could not verify caller-owned services");
    expect(payload.outcomes).toHaveLength(6);
    expect(workpoolCalls).toBe(0);
    expect(waitCalls).toBe(0);
  });
  test("Pool worker failures stay failures instead of inheriting batch success", async () => {
    const spec = validateSpec({
      context: "Ctx",
      tasks: Array.from({ length: 6 }, (_, i) => ({ name: `e${i}`, agent: "sonic", task: `E${i}` })),
    });
    const groupId = "tg-worker-error";
    const ids = Array.from({ length: 6 }, (_, i) => `${groupId}#${i + 1}`);
    let pushed = false;
    const pool = {
      push: (...items: string[]) => {
        pushed = true;
        expect(items).toHaveLength(6);
        return ids;
      },
      status: async () => ({
        name: groupId,
        agent: "sonic",
        limit: 2,
        closed: pushed,
        freshAgents: false,
        agents: [],
        items: pushed
          ? { queued: 0, running: 0, completed: 0, failed: 6, cancelled: 0 }
          : { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 },
        batches: pushed ? 1 : 0,
      }),
      peek: async () => ({
        batches: pushed
          ? [{ id: "worker-bad-b1", agent: "worker-bad", items: ids, status: "failed", output: "worker crashed before result" }]
          : [],
        pending: 0,
      }),
      close: async () => ({ dropped: [] as string[] }),
    };
    let waitCalls = 0;
    let workpoolCalls = 0;
    const tool = Object.assign(async () => ({}), {
      read: async () => ({ details: { proc: { jobs: [], agents: [], daemons: [] } } }),
      wait: async () => {
        waitCalls++;
        return { details: { op: "wait", jobs: waitCalls === 1 ? [] : [{ id: groupId, status: "completed" }] } };
      },
      write: async () => ({ details: { proc: { cancelled: [{ id: groupId, status: "cancelled" }] } } }),
    });
    const kernel: MockKernel = { consoleValues: [], phases: [], completionPrompts: [], run: async () => {} };
    const fns: FnMap = {
      agent: async () => {
        throw new Error("Pool batch failures must not rerun as Fanout");
      },
      wait: async () => [],
      completion: async () => ({ wait: async () => "digest" }),
      workpool: async () => {
        workpoolCalls++;
        return pool;
      },
      tool,
    };
    installRunner(kernel, fns);
    await kernel.run(compilePoolProgram(spec, { groupId }));
    const payload = lastEvalPayload(kernel);

    expect(payload.strategy).toBe("pool");
    expect(payload.groupState).toBe("failed");
    expect(payload.outcomes).toHaveLength(6);
    expect(payload.outcomes.every((outcome) => outcome.status === "failed")).toBe(true);
    expect(workpoolCalls).toBe(1);
    expect(waitCalls).toBe(2);
  });

  test("Pool reports a drained all-cancelled snapshot as a cancelled group", async () => {
    const spec = validateSpec({
      context: "Ctx",
      tasks: [
        { name: "k0", agent: "sonic", task: "K0" },
        { name: "k1", agent: "sonic", task: "K1" },
      ],
    });
    const groupId = "tg-cancel-drained";
    const ids = [`${groupId}#1`, `${groupId}#2`];
    let pushed = false;
    const pool = {
      push: (...items: string[]) => {
        pushed = true;
        expect(items).toHaveLength(2);
        return ids;
      },
      status: async () => ({
        name: groupId,
        agent: "sonic",
        limit: 2,
        closed: pushed,
        freshAgents: false,
        agents: [],
        items: pushed
          ? { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 2 }
          : { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 },
        batches: pushed ? 1 : 0,
      }),
      peek: async () => ({
        batches: pushed
          ? [{ id: "worker-cancel-b1", agent: "worker-cancel", items: ids, status: "cancelled" }]
          : [],
        pending: 0,
      }),
      close: async () => ({ dropped: [] as string[] }),
    };
    let waitCalls = 0;
    const tool = Object.assign(async () => ({}), {
      read: async () => ({ details: { proc: { jobs: [], agents: [], daemons: [] } } }),
      wait: async () => {
        waitCalls++;
        return { details: { op: "wait", jobs: waitCalls === 1 ? [] : [{ id: groupId, status: "completed" }] } };
      },
      write: async () => ({ details: { proc: { cancelled: [{ id: groupId, status: "cancelled" }] } } }),
    });
    const kernel: MockKernel = { consoleValues: [], phases: [], completionPrompts: [], run: async () => {} };
    installRunner(kernel, {
      agent: async () => {
        throw new Error("Pool cancellation must not rerun as Fanout");
      },
      wait: async () => [],
      completion: async () => ({ wait: async () => "digest" }),
      workpool: async () => pool,
      tool,
    });
    await kernel.run(compilePoolProgram(spec, { groupId }));
    const payload = lastEvalPayload(kernel);

    expect(payload.strategy).toBe("pool");
    expect(payload.groupState).toBe("cancelled");
    expect(payload.outcomes.map((outcome) => outcome.status)).toEqual(["cancelled", "cancelled"]);
    expect(payload.groupError).toBeUndefined();
  });

  test("Pool surfaces a native failed batch diagnostic instead of a generic message", async () => {
    const spec = validateSpec({
      context: "Ctx",
      tasks: [
        { name: "n0", agent: "sonic", task: "N0" },
        { name: "n1", agent: "sonic", task: "N1" },
      ],
    });
    const groupId = "tg-batch-diagnostic";
    const ids = [`${groupId}#1`, `${groupId}#2`];
    let pushed = false;
    const pool = {
      push: () => {
        pushed = true;
        return ids;
      },
      status: async () => ({
        name: groupId,
        agent: "sonic",
        limit: 2,
        closed: pushed,
        freshAgents: false,
        agents: [],
        items: pushed
          ? { queued: 0, running: 0, completed: 0, failed: 2, cancelled: 0 }
          : { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 },
        batches: pushed ? 1 : 0,
      }),
      peek: async () => ({
        batches: pushed
          ? [{ id: "worker-crash-b1", agent: "worker-crash", items: ids, status: "failed", output: "worker crashed: ENOENT /tmp/x" }]
          : [],
        pending: 0,
      }),
      close: async () => ({ dropped: [] as string[] }),
    };
    let waitCalls = 0;
    const tool = Object.assign(async () => ({}), {
      read: async () => ({ details: { proc: { jobs: [], agents: [], daemons: [] } } }),
      wait: async () => {
        waitCalls++;
        return { details: { op: "wait", jobs: waitCalls === 1 ? [] : [{ id: groupId, status: "completed" }] } };
      },
      write: async () => ({ details: { proc: { cancelled: [{ id: groupId, status: "cancelled" }] } } }),
    });
    const kernel: MockKernel = { consoleValues: [], phases: [], completionPrompts: [], run: async () => {} };
    installRunner(kernel, {
      agent: async () => {
        throw new Error("Pool batch failures must not rerun as Fanout");
      },
      wait: async () => [],
      completion: async () => ({ wait: async () => "digest" }),
      workpool: async () => pool,
      tool,
    });
    await kernel.run(compilePoolProgram(spec, { groupId }));
    const payload = lastEvalPayload(kernel);

    expect(payload.groupState).toBe("failed");
    expect(payload.outcomes.map((outcome) => outcome.status)).toEqual(["failed", "failed"]);
    expect(payload.outcomes.map((outcome) => outcome.error)).toEqual([
      "worker crashed: ENOENT /tmp/x",
      "worker crashed: ENOENT /tmp/x",
    ]);
  });

  test("Pool keeps a partial success completed while a failed batch reports its diagnostic", async () => {
    const spec = validateSpec({
      context: "Ctx",
      tasks: [
        { name: "q0", agent: "sonic", task: "Q0" },
        { name: "q1", agent: "sonic", task: "Q1" },
        { name: "q2", agent: "sonic", task: "Q2" },
        { name: "q3", agent: "sonic", task: "Q3" },
      ],
    });
    const groupId = "tg-mixed-batches";
    const ids = Array.from({ length: 4 }, (_, i) => `${groupId}#${i + 1}`);
    let pushed = false;
    const goodOutput = JSON.stringify({
      [ids[0] as string]: { stdout: "ok-0", wallTime: "1 second", files: [] },
      [ids[1] as string]: { stdout: "ok-1", wallTime: "2 seconds", files: [] },
    });
    const pool = {
      push: () => {
        pushed = true;
        return ids;
      },
      status: async () => ({
        name: groupId,
        agent: "sonic",
        limit: 2,
        closed: pushed,
        freshAgents: false,
        agents: [],
        items: pushed
          ? { queued: 0, running: 0, completed: 2, failed: 2, cancelled: 0 }
          : { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 },
        batches: pushed ? 2 : 0,
      }),
      peek: async () => ({
        batches: pushed
          ? [
              { id: "worker-ok-b1", agent: "worker-ok", items: ids.slice(0, 2), status: "completed", output: goodOutput },
              { id: "worker-bad-b1", agent: "worker-bad", items: ids.slice(2), status: "failed", output: "worker crashed: ECONNRESET" },
            ]
          : [],
        pending: 0,
      }),
      close: async () => ({ dropped: [] as string[] }),
    };
    let waitCalls = 0;
    const tool = Object.assign(async () => ({}), {
      read: async () => ({ details: { proc: { jobs: [], agents: [], daemons: [] } } }),
      wait: async () => {
        waitCalls++;
        return { details: { op: "wait", jobs: waitCalls === 1 ? [] : [{ id: groupId, status: "completed" }] } };
      },
      write: async () => ({ details: { proc: { cancelled: [{ id: groupId, status: "cancelled" }] } } }),
    });
    const kernel: MockKernel = { consoleValues: [], phases: [], completionPrompts: [], run: async () => {} };
    installRunner(kernel, {
      agent: async () => {
        throw new Error("Pool batch failures must not rerun as Fanout");
      },
      wait: async () => [],
      completion: async () => ({ wait: async () => "digest" }),
      workpool: async () => pool,
      tool,
    });
    await kernel.run(compilePoolProgram(spec, { groupId }));
    const payload = lastEvalPayload(kernel);

    expect(payload.groupState).toBe("completed");
    expect(payload.outcomes.map((outcome) => outcome.status)).toEqual([
      "succeeded",
      "succeeded",
      "failed",
      "failed",
    ]);
    expect(byName(payload, "q2").error).toBe("worker crashed: ECONNRESET");
    expect(byName(payload, "q3").error).toBe("worker crashed: ECONNRESET");
  });

  test("Pool keeps JSON-object string results as text unless they are exact protocol envelopes", async () => {
    const spec = validateSpec({
      context: "Ctx",
      tasks: [
        { name: "s0", agent: "sonic", task: "S0" },
        { name: "s1", agent: "sonic", task: "S1" },
      ],
    });
    const groupId = "tg-string-results";
    const ids = [`${groupId}#1`, `${groupId}#2`];
    const literal = JSON.stringify({ stdout: "captured output", wallTime: "5 seconds", files: ["child.started"] });
    const encodedEnvelope = JSON.stringify({ status: "succeeded", value: { stdout: "inner" } });
    let pushed = false;
    const pool = {
      push: () => {
        pushed = true;
        return ids;
      },
      status: async () => ({
        name: groupId,
        agent: "sonic",
        limit: 2,
        closed: pushed,
        freshAgents: false,
        agents: [],
        items: pushed
          ? { queued: 0, running: 0, completed: 2, failed: 0, cancelled: 0 }
          : { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 },
        batches: pushed ? 1 : 0,
      }),
      peek: async () => ({
        batches: pushed
          ? [
              {
                id: "worker-json-b1",
                agent: "worker-json",
                items: ids,
                status: "completed",
                output: JSON.stringify({ [ids[0] as string]: literal, [ids[1] as string]: encodedEnvelope }),
              },
            ]
          : [],
        pending: 0,
      }),
      close: async () => ({ dropped: [] as string[] }),
    };
    let waitCalls = 0;
    const tool = Object.assign(async () => ({}), {
      read: async () => ({ details: { proc: { jobs: [], agents: [], daemons: [] } } }),
      wait: async () => {
        waitCalls++;
        return { details: { op: "wait", jobs: waitCalls === 1 ? [] : [{ id: groupId, status: "completed" }] } };
      },
      write: async () => ({ details: { proc: { cancelled: [{ id: groupId, status: "cancelled" }] } } }),
    });
    const kernel: MockKernel = { consoleValues: [], phases: [], completionPrompts: [], run: async () => {} };
    installRunner(kernel, {
      agent: async () => {
        throw new Error("Pool must not rerun as Fanout");
      },
      wait: async () => [],
      completion: async () => ({ wait: async () => "digest" }),
      workpool: async () => pool,
      tool,
    });
    await kernel.run(compilePoolProgram(spec, { groupId }));
    const payload = lastEvalPayload(kernel);

    expect(payload.groupState).toBe("completed");
    expect(byName(payload, "s0")).toMatchObject({ status: "succeeded", result: literal });
    expect(byName(payload, "s0").structured).toBeUndefined();
    expect(byName(payload, "s1")).toMatchObject({ status: "succeeded", structured: { stdout: "inner" } });
    expect(byName(payload, "s1").result).toBeUndefined();
  });

  test("Pool rejects truncated and incomplete batch output without claiming success", async () => {
    const spec = validateSpec({
      context: "Ctx",
      tasks: Array.from({ length: 6 }, (_, i) => ({ name: `m${i}`, agent: "sonic", task: `M${i}` })),
    });
    const groupId = "tg-missing-output";
    const ids = Array.from({ length: 6 }, (_, i) => `${groupId}#${i + 1}`);
    let pushed = false;
    const pool = {
      push: () => {
        pushed = true;
        return ids;
      },
      status: async () => ({
        name: groupId,
        agent: "sonic",
        limit: 2,
        closed: pushed,
        freshAgents: false,
        agents: [],
        items: pushed
          ? { queued: 0, running: 0, completed: 6, failed: 0, cancelled: 0 }
          : { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 },
        batches: pushed ? 2 : 0,
      }),
      peek: async () => ({
        batches: pushed
          ? [
              {
                id: "worker-truncated-b1",
                agent: "worker-truncated",
                items: ids.slice(0, 3),
                status: "completed",
                output: "{",
              },
              {
                id: "worker-duplicate-b2",
                agent: "worker-duplicate",
                items: [ids[3] as string, ids[4] as string, ids[4] as string],
                status: "completed",
                output: JSON.stringify({
                  [ids[3] as string]: { status: "succeeded", value: "M3" },
                  [ids[4] as string]: { status: "succeeded", value: "M4" },
                }, null, 2),
              },
            ]
          : [],
        pending: 0,
      }),
      close: async () => ({ dropped: [] as string[] }),
    };
    let waitCalls = 0;
    const tool = Object.assign(async () => ({}), {
      read: async () => ({ details: { proc: { jobs: [], agents: [], daemons: [] } } }),
      wait: async () => ({
        details: {
          op: "wait",
          jobs: waitCalls++ === 0 ? [] : [{ id: groupId, status: "completed" }],
        },
      }),
      write: async () => ({ details: { proc: { cancelled: [{ id: groupId, status: "cancelled" }] } } }),
    });
    const kernel: MockKernel = { consoleValues: [], phases: [], completionPrompts: [], run: async () => {} };
    installRunner(kernel, {
      agent: async () => {
        throw new Error("Truncated Pool output must not rerun as Fanout");
      },
      wait: async () => [],
      completion: async () => ({ wait: async () => "digest" }),
      workpool: async () => pool,
      tool,
    });
    await kernel.run(compilePoolProgram(spec, { groupId }));
    const payload = lastEvalPayload(kernel);

    expect(payload.strategy).toBe("pool");
    expect(payload.groupState).toBe("failed");
    expect(payload.outcomes).toHaveLength(6);
    expect(payload.outcomes.every((outcome) => outcome.status === "failed")).toBe(true);
    expect(payload.groupError).toContain("Workpool");
    expect(byName(payload, "m0").error).toContain("invalid or truncated JSON");
    expect(byName(payload, "m3").error).toContain("did not cover exactly");
    expect(byName(payload, "m4").error).toContain("duplicated item");
    expect(byName(payload, "m5").error).toContain("omitted item");
    expect(waitCalls).toBe(2);
  });

  test("Pool rejects duplicate JSON object keys instead of accepting parser overwrite", async () => {
    const spec = validateSpec({
      context: "Ctx",
      tasks: Array.from({ length: 6 }, (_, i) => ({ name: `d${i}`, agent: "sonic", task: `D${i}` })),
    });
    const groupId = "tg-duplicate-json-keys";
    const ids = Array.from({ length: 6 }, (_, i) => `${groupId}#${i + 1}`);
    const entries = ids.map((id, index) =>
      JSON.stringify(id) + ":" + JSON.stringify({ status: "succeeded", value: `D${index}` }),
    );
    const output = `{${[entries[0], entries[0], ...entries.slice(1)].join(",")}}`;
    let pushed = false;
    const pool = {
      push: () => {
        pushed = true;
        return ids;
      },
      status: async () => ({
        name: groupId,
        agent: "sonic",
        limit: 2,
        closed: pushed,
        freshAgents: false,
        agents: [],
        items: pushed
          ? { queued: 0, running: 0, completed: 6, failed: 0, cancelled: 0 }
          : { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 },
        batches: pushed ? 1 : 0,
      }),
      peek: async () => ({
        batches: pushed
          ? [{ id: "worker-duplicate-json", agent: "worker-duplicate-json", items: ids, status: "completed", output }]
          : [],
        pending: 0,
      }),
      close: async () => ({ dropped: [] as string[] }),
    };
    let waitCalls = 0;
    const tool = Object.assign(async () => ({}), {
      read: async () => ({ details: { proc: { jobs: [], agents: [], daemons: [] } } }),
      wait: async () => ({
        details: { op: "wait", jobs: waitCalls++ === 0 ? [] : [{ id: groupId, status: "completed" }] },
      }),
      write: async () => ({ details: { proc: { cancelled: [{ id: groupId, status: "cancelled" }] } } }),
    });
    const kernel: MockKernel = { consoleValues: [], phases: [], completionPrompts: [], run: async () => {} };
    let agentCalls = 0;
    installRunner(kernel, {
      agent: async () => {
        agentCalls++;
        throw new Error("duplicate Pool JSON must not rerun as Fanout");
      },
      wait: async () => [],
      completion: async () => ({ wait: async () => "digest" }),
      workpool: async () => pool,
      tool,
    });
    await kernel.run(compilePoolProgram(spec, { groupId }));
    const payload = lastEvalPayload(kernel);

    expect(payload.groupState).toBe("failed");
    expect(payload.groupError).toContain("duplicate JSON object keys");
    expect(payload.outcomes).toHaveLength(6);
    expect(payload.outcomes.every((outcome) => outcome.status === "failed")).toBe(true);
    expect(agentCalls).toBe(0);
    expect(waitCalls).toBe(2);
  });

  test("invalid push mapping cancels and reaps dispatched work without rerunning", async () => {
    const spec = validateSpec({
      context: "Ctx",
      tasks: Array.from({ length: 6 }, (_, i) => ({ name: `p${i}`, agent: "sonic", task: `P${i}` })),
    });
    const groupId = "tg-partial-push";
    const ids = Array.from({ length: 6 }, (_, i) => `${groupId}#${i + 1}`);
    let pushed = false;
    let closed = false;
    const pool = {
      push: () => {
        pushed = true;
        return ids.slice(0, 1);
      },
      status: async () => ({
        name: groupId,
        agent: "sonic",
        limit: 2,
        closed,
        freshAgents: false,
        agents: [],
        items: !pushed
          ? { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 }
          : closed
            ? { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 1 }
            : { queued: 1, running: 0, completed: 0, failed: 0, cancelled: 0 },
        batches: 0,
      }),
      peek: async () => ({ batches: [], pending: pushed && !closed ? 1 : 0 }),
      close: async () => {
        closed = true;
        return { dropped: [ids[0]] };
      },
    };
    let waitCalls = 0;
    let writeCalls = 0;
    const tool = Object.assign(async () => ({}), {
      read: async () => ({
        details: {
          proc: {
            jobs: pushed ? [{ id: groupId, status: "cancelled", errorText: "pool cancelled" }] : [],
            agents: [],
            daemons: [],
          },
        },
      }),
      wait: async () => ({
        details: { op: "wait", jobs: waitCalls++ === 0 ? [] : [{ id: groupId, status: "cancelled" }] },
      }),
      write: async () => {
        writeCalls++;
        return { details: { proc: { cancelled: [{ id: groupId, status: "cancelled" }] } } };
      },
    });
    const kernel: MockKernel = { consoleValues: [], phases: [], completionPrompts: [], run: async () => {} };
    let agentCalls = 0;
    installRunner(kernel, {
      agent: async () => {
        agentCalls++;
        throw new Error("partially submitted Pool must not rerun as Fanout");
      },
      wait: async () => [],
      completion: async () => ({ wait: async () => "digest" }),
      workpool: async () => pool,
      tool,
    });
    await kernel.run(compilePoolProgram(spec, { groupId }));
    const payload = lastEvalPayload(kernel);

    expect(payload.strategy).toBe("pool");
    expect(payload.groupState).toBe("cancelled");
    expect(payload.groupError).toContain("did not return one unique item id per task");
    expect(payload.outcomes).toHaveLength(6);
    expect(byName(payload, "p0").status).toBe("cancelled");
    expect(payload.outcomes.filter((outcome) => outcome.status === "failed")).toHaveLength(5);
    expect(agentCalls).toBe(0);
    expect(waitCalls).toBe(2);
    expect(writeCalls).toBe(1);
  });

  test("Pool returns after cancellation instead of parking on an owned service", async () => {
    const spec = validateSpec({
      context: "Ctx",
      tasks: Array.from({ length: 6 }, (_, i) => ({ name: `i${i}`, agent: "sonic", task: `I${i}` })),
    });
    const groupId = "tg-idle-after-cancel";
    const ids = Array.from({ length: 6 }, (_, i) => `${groupId}#${i + 1}`);
    let pushed = false;
    let closed = false;
    const pool = {
      push: () => {
        pushed = true;
        return ids;
      },
      status: async () => ({
        name: groupId,
        agent: "sonic",
        limit: 2,
        closed,
        freshAgents: false,
        agents: [],
        items: !pushed
          ? { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 }
          : closed
            ? { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 6 }
            : { queued: 6, running: 0, completed: 0, failed: 0, cancelled: 0 },
        batches: 0,
      }),
      peek: async () => ({ batches: [], pending: pushed && !closed ? 6 : 0 }),
      close: async () => {
        closed = true;
        return { dropped: ids };
      },
    };
    let waitCalls = 0;
    let writeCalls = 0;
    const tool = Object.assign(async () => ({}), {
      read: async () => ({
        details: { proc: { jobs: [], agents: [], daemons: [{ id: "live-service" }] } },
      }),
      wait: async () => {
        waitCalls++;
        return { details: { op: "wait", interrupted: true } };
      },
      write: async () => {
        writeCalls++;
        return { details: { proc: { cancelled: [{ id: groupId, status: "cancelled" }] } } };
      },
    });
    const kernel: MockKernel = { consoleValues: [], phases: [], completionPrompts: [], run: async () => {} };
    let agentCalls = 0;
    installRunner(kernel, {
      agent: async () => {
        agentCalls++;
        throw new Error("Pool with no waitable job must not rerun as Fanout");
      },
      wait: async () => [],
      completion: async () => ({ wait: async () => "digest" }),
      workpool: async () => pool,
      tool,
    });
    await kernel.run(compilePoolProgram(spec, { groupId }));
    const payload = lastEvalPayload(kernel);

    expect(payload.groupState).toBe("cancelled");
    expect(payload.groupError).toContain("no waitable aggregate or batch job");
    expect(payload.outcomes).toHaveLength(6);
    expect(payload.outcomes.every((outcome) => outcome.status === "cancelled")).toBe(true);
    expect(waitCalls).toBe(1);
    expect(writeCalls).toBe(1);
    expect(agentCalls).toBe(0);
  });

  test("Pool bounds repeated Wait calls when cancellation leaves its aggregate running", async () => {
    vi.useFakeTimers();
    try {
      const spec = validateSpec({
        context: "Ctx",
        tasks: Array.from({ length: 6 }, (_, i) => ({ name: `r${i}`, agent: "sonic", task: `R${i}` })),
      });
      const groupId = "tg-stuck-cancel";
      const ids = Array.from({ length: 6 }, (_, i) => `${groupId}#${i + 1}`);
      const waitGate = Promise.withResolvers<unknown>();
      let pushed = false;
      let closed = false;
      let waitCalls = 0;
      let writeCalls = 0;
      const pool = {
        push: () => {
          pushed = true;
          return ids;
        },
        status: async () => ({
          name: groupId,
          agent: "sonic",
          limit: 2,
          closed,
          freshAgents: false,
          agents: [],
          items: !pushed
            ? { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 }
            : { queued: 0, running: 6, completed: 0, failed: 0, cancelled: 0 },
          batches: pushed ? 1 : 0,
        }),
        peek: async () => ({
          batches: pushed
            ? [{ id: "worker-stuck-b1", agent: "worker-stuck", items: ids, status: "running" }]
            : [],
          pending: pushed ? 6 : 0,
        }),
        close: async () => {
          closed = true;
          return { dropped: [] as string[] };
        },
      };
      const tool = Object.assign(async () => ({}), {
        read: async () => ({
          details: {
            proc: {
              jobs: pushed
                ? [{ id: groupId, status: "running" }, { id: "worker-stuck-b1", status: "running" }]
                : [],
              agents: [],
              daemons: [{ id: "live-service" }],
            },
          },
        }),
        wait: async () => {
          waitCalls++;
          return waitCalls === 1
            ? waitGate.promise
            : {
                details: {
                  op: "wait",
                  jobs: [{ id: groupId, status: "running" }, { id: "worker-stuck-b1", status: "running" }],
                },
              };
        },
        write: async () => {
          writeCalls++;
          waitGate.resolve({
            details: {
              op: "wait",
              jobs: [{ id: groupId, status: "running" }, { id: "worker-stuck-b1", status: "running" }],
            },
          });
          return { details: { proc: { cancelled: [{ id: groupId, status: "cancelled" }] } } };
        },
      });
      const kernel: MockKernel = { consoleValues: [], phases: [], completionPrompts: [], run: async () => {} };
      let agentCalls = 0;
      installRunner(kernel, {
        agent: async () => {
          agentCalls++;
          throw new Error("stuck Pool must not rerun as Fanout");
        },
        wait: async () => [],
        completion: async () => ({ wait: async () => "digest" }),
        workpool: async () => pool,
        tool,
      });
      const run = kernel.run(compilePoolProgram(spec, { groupId, maxGroupMs: 10 }));
      for (let spin = 0; spin < 100 && waitCalls < 1; spin++) await Promise.resolve();
      expect(waitCalls).toBe(1);
      vi.advanceTimersByTime(10);
      await run;
      const payload = lastEvalPayload(kernel);

      expect(payload.groupState).toBe("failed");
      expect(payload.groupError).toContain("bounded cancellation waits");
      expect(payload.outcomes).toHaveLength(6);
      expect(payload.outcomes.every((outcome) => outcome.status === "failed")).toBe(true);
      expect(waitCalls).toBe(2);
      expect(writeCalls).toBe(1);
      expect(agentCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  test("Pool timeout closes queued work, kills the aggregate job, and does not rerun tasks", async () => {
    vi.useFakeTimers();
    try {
      const spec = validateSpec({
        context: "Ctx",
        tasks: Array.from({ length: 6 }, (_, i) => ({ name: `c${i}`, agent: "sonic", task: `C${i}` })),
      });
      const groupId = "tg-pool-timeout";
      const ids = Array.from({ length: 6 }, (_, i) => `${groupId}#${i + 1}`);
      const waitGate = Promise.withResolvers<unknown>();
      let pushed = false;
      let closed = false;
      let waitCalls = 0;
      let writeCalls = 0;
      const pool = {
        push: () => {
          pushed = true;
          return ids;
        },
        status: async () => ({
          name: groupId,
          agent: "sonic",
          limit: 2,
          closed,
          freshAgents: false,
          agents: [],
          items: !pushed
            ? { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 }
            : closed
              ? { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 6 }
              : { queued: 6, running: 0, completed: 0, failed: 0, cancelled: 0 },
          batches: 0,
        }),
        peek: async () => ({ batches: [], pending: closed ? 0 : pushed ? 6 : 0 }),
        close: async () => {
          closed = true;
          return { dropped: ids };
        },
      };
      const tool = Object.assign(async () => ({}), {
        read: async () => ({ details: { proc: { jobs: [], agents: [], daemons: [] } } }),
        wait: async () => {
          waitCalls++;
          return waitCalls === 1 ? { details: { op: "wait", jobs: [] } } : waitGate.promise;
        },
        write: async ({ path }: { path: string }) => {
          writeCalls++;
          expect(path).toBe(`proc://${groupId}/kill`);
          waitGate.resolve({ details: { op: "wait", jobs: [{ id: groupId, status: "cancelled" }] } });
          return { details: { proc: { op: "cancel", jobs: [], cancelled: [{ id: groupId, status: "cancelled" }] } } };
        },
      });
      const kernel: MockKernel = { consoleValues: [], phases: [], completionPrompts: [], run: async () => {} };
      let workpoolCalls = 0;
      let agentCalls = 0;
      installRunner(kernel, {
        agent: async () => {
          agentCalls++;
          throw new Error("Pool timeout must not rerun tasks as Fanout");
        },
        wait: async () => [],
        completion: async () => ({ wait: async () => "digest" }),
        workpool: async () => {
          workpoolCalls++;
          return pool;
        },
        tool,
      });
      const run = kernel.run(compilePoolProgram(spec, { groupId, maxGroupMs: 25 }));
      for (let attempt = 0; waitCalls < 2 && attempt < 100; attempt++) await Promise.resolve();
      expect(waitCalls).toBe(2);
      vi.advanceTimersByTime(25);
      await run;
      const payload = lastEvalPayload(kernel);

      expect(payload.strategy).toBe("pool");
      expect(payload.groupState).toBe("failed");
      expect(payload.groupError).toContain("maxGroupMs");
      expect(payload.outcomes).toHaveLength(6);
      expect(payload.outcomes.every((outcome) => outcome.status === "cancelled")).toBe(true);
      expect(workpoolCalls).toBe(1);
      expect(agentCalls).toBe(0);
      expect(writeCalls).toBe(1);
      expect(waitCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
  test("fanout emits its completed result through OMP's console JSON view without a display global", async () => {
    const logged: unknown[] = [];
    let settled = 0;
    const program = compileFanoutProgram(SPEC3, { groupId: "tg-console" });
    const agent = async (_prompt: string, opts: { label: string }) => ({
      handle: `agent://${opts.label}`,
      wait: async () => {
        settled += 1;
        return `result:${opts.label}`;
      },
      cancel: async () => {},
    });
    const createRunner = new Function(
      "agent", "wait", "completion", "workpool", "console", "phase", "tool",
      `return async () => {\n${program}\n}`,
    ) as (...args: unknown[]) => () => Promise<void>;
    const run = createRunner(
      agent,
      async () => [],
      async () => ({ wait: async () => "digest" }),
      async () => { throw new Error("unexpected workpool"); },
      { log: (...values: unknown[]) => logged.push(...values) },
      () => {},
      {},
    );

    await run();

    expect(settled).toBe(3);
    expect(logged).toHaveLength(1);
    const chunk = logged[0] as Record<string, unknown>;
    expect(chunk).toMatchObject({
      protocol: EVAL_RESULT_PROTOCOL,
      groupId: "tg-console",
      transport: EVAL_RESULT_TRANSPORT,
      chunkIndex: 0,
      chunkCount: 1,
    });
    expect(typeof chunk.data).toBe("string");
    const payload = JSON.parse(chunk.data as string) as TaskGroupResultPayload;
    expect(payload.groupState).toBe("completed");
    expect(payload.outcomes.map((outcome) => outcome.name).sort()).toEqual(["p0", "p1", "p2"]);
  });

  test("large child output survives chunking across OMP JSON views", async () => {
    const spec = validateSpec({
      context: "Ctx",
      output: { mode: "compact", perTaskChars: 20_000, maxTotalChars: 50_000, preserveHandles: true },
      tasks: [
        { name: "large", agent: "sonic", task: "Large" },
        { name: "small", agent: "sonic", task: "Small" },
      ],
    });
    const largeResult = '"'.repeat(16_000);
    const { kernel } = await runFanout(spec, "tg-chunked", [largeResult, "small"]);

    expect(kernel.consoleValues.length).toBeGreaterThan(1);
    expect(byName(lastEvalPayload(kernel), "large").result).toBe(largeResult);
  });

});

describe("two-phase background program execution", () => {
  /** Mock the write-approved store tool and capture the payload it receives. */
  function makeStoreTool(capture: { calls: number; payloadJson?: string }, groupId: string, resultId: string) {
    return {
      task_group_store_result: async (args: {
        groupId: string;
        resultId: string;
        payloadJson: string;
      }) => {
        capture.calls += 1;
        expect(args.groupId).toBe(groupId);
        expect(args.resultId).toBe(resultId);
        capture.payloadJson = args.payloadJson;
        return {
          text: "stored",
          details: {
            protocol: "omp-task-group/background-v1",
            state: "ready",
            groupId: args.groupId,
            resultId: args.resultId,
            path: "/tmp/mock-result.json",
            checksum: sha256Hex(args.payloadJson),
            payloadChars: args.payloadJson.length,
            alreadyStored: false,
          },
          hasError: false,
        };
      },
    };
  }

  interface DispatchView {
    transport: string;
    state: string;
    itemIds: string[];
    groupId: string;
    resultId: string;
    poolName: string;
    taskCount: number;
  }

  interface CollectView {
    transport: string;
    state: string;
    groupState?: string;
    counts?: { succeeded: number; failed: number; cancelled: number };
    path?: string;
    checksum?: string;
    payloadChars?: number;
    stage?: string;
    reason?: string;
  }

  const REGISTRY = "__ompTaskGroupPoolBackgroundV1";

  function makeBackgroundKernel(workpool: unknown, tool: unknown = {}): MockKernel {
    const kernel: MockKernel = { consoleValues: [], phases: [], completionPrompts: [], run: async () => {} };
    installRunner(kernel, { workpool, tool, fs: fsModule });
    return kernel;
  }

  function makePool(groupId: string, state: { mode: "running" | "completed" | "cancelled" }): {
    pool: Record<string, unknown>;
    pushed: string[];
  } {
    const pushed: string[] = [];
    const pool = {
      async push(...prompts: string[]): Promise<string[]> {
        pushed.push(...prompts);
        return prompts.map((_, index) => `${groupId}#${index + 1}`);
      },
      async status(): Promise<Record<string, unknown>> {
        if (pushed.length === 0) {
          return {
            name: groupId,
            closed: false,
            batches: 0,
            agents: ["sonic"],
            items: { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 },
          };
        }
        const completed = state.mode === "completed" ? 2 : 0;
        const cancelled = state.mode === "cancelled" ? 2 : 0;
        return {
          name: groupId,
          closed: state.mode !== "running",
          batches: 1,
          agents: ["sonic"],
          items: {
            queued: 0,
            running: state.mode === "running" ? 2 : 0,
            completed,
            failed: 0,
            cancelled,
          },
        };
      },
      async peek(): Promise<Record<string, unknown>> {
        if (pushed.length === 0) return { pending: 0, batches: [] };
        if (state.mode === "running") {
          return { pending: 2, batches: [{ id: "b1", agent: "sonic", status: "running", items: [`${groupId}#1`, `${groupId}#2`] }] };
        }
        if (state.mode === "cancelled") {
          return { pending: 0, batches: [{ id: "b1", agent: "sonic", status: "cancelled", items: [`${groupId}#1`, `${groupId}#2`] }] };
        }
        return {
          pending: 0,
          batches: [{
            id: "b1",
            agent: "sonic",
            status: "completed",
            items: [`${groupId}#1`, `${groupId}#2`],
            output: JSON.stringify({
              [`${groupId}#1`]: JSON.stringify({ status: "succeeded", value: "one" }),
              [`${groupId}#2`]: JSON.stringify({ status: "succeeded", value: "two" }),
            }),
          }],
        };
      },
      async close(): Promise<Record<string, unknown>> {
        return { dropped: [] };
      },
    };
    return { pool, pushed };
  }

  const TWO_TASK_SPEC = validateSpec({
    context: "ctx",
    background: "require",
    tasks: [
      { name: "alpha", agent: "sonic", task: "return one" },
      { name: "beta", agent: "sonic", task: "return two" },
    ],
    join: { mode: "all" },
    failure: { mode: "collect" },
    execution: { strategy: "auto", concurrency: "auto" },
    output: { mode: "compact", perTaskChars: 200, maxTotalChars: 4000, preserveHandles: true },
  });

  test("dispatch retains the handle and returns verified ids without waiting", async () => {
    const groupId = "tg-unittest-dispatch";
    const resultId = "tgbg_0123456789abcdef";
    delete (globalThis as Record<string, unknown>)[REGISTRY];
    const state = { mode: "running" as const };
    const { pool, pushed } = makePool(groupId, state);
    const kernel = makeBackgroundKernel(async () => pool);
    await kernel.run(
      compilePoolBackgroundDispatchProgram(TWO_TASK_SPEC, { groupId, background: { resultId } }),
    );

    expect(pushed).toHaveLength(2);
    expect(kernel.consoleValues).toHaveLength(1);
    const view = kernel.consoleValues[0] as unknown as DispatchView;
    expect(view.transport).toBe(POOL_BACKGROUND_DISPATCH_TRANSPORT);
    expect(view.state).toBe("dispatched");
    expect(view.groupId).toBe(groupId);
    expect(view.resultId).toBe(resultId);
    expect(view.poolName).toBe(groupId);
    expect(view.itemIds).toEqual([`${groupId}#1`, `${groupId}#2`]);
    expect(view.taskCount).toBe(2);

    const registry = (globalThis as Record<string, unknown>)[REGISTRY] as {
      groups: Map<string, Record<string, unknown>>;
    };
    const entry = registry.groups.get(groupId);
    expect(entry).toBeDefined();
    expect(entry?.resultId).toBe(resultId);
    expect(entry?.ids).toEqual([`${groupId}#1`, `${groupId}#2`]);
    expect(entry?.pool).toBe(pool);
    delete (globalThis as Record<string, unknown>)[REGISTRY];
  });

  test("collect reports pending, then stores one verified payload through the write tool", async () => {
    const groupId = "tg-unittest-collect";
    const resultId = "tgbg_0123456789abcdef";
    const path = "/tmp/mock-result.json";
    delete (globalThis as Record<string, unknown>)[REGISTRY];
    const state = { mode: "running" as "running" | "completed" };
    const { pool } = makePool(groupId, state);
    const dispatchKernel = makeBackgroundKernel(async () => pool);
    await dispatchKernel.run(
      compilePoolBackgroundDispatchProgram(TWO_TASK_SPEC, { groupId, background: { resultId } }),
    );

    const collectProgram = compilePoolBackgroundCollectProgram(TWO_TASK_SPEC, {
      groupId,
      collect: { resultId, path, storeCapability: "a".repeat(64) },
    });
    const pendingCapture = { calls: 0, payloadJson: undefined as string | undefined };
    const pendingKernel = makeBackgroundKernel(
      async () => pool,
      makeStoreTool(pendingCapture, groupId, resultId),
    );
    await pendingKernel.run(collectProgram);
    const pending = pendingKernel.consoleValues[0] as unknown as CollectView;
    expect(pending.transport).toBe(POOL_BACKGROUND_COLLECT_TRANSPORT);
    expect(pending.state).toBe("pending");
    expect(pending.reason).toContain("queued or running");
    expect(pending.groupState).toBeUndefined();
    expect(pendingCapture.calls).toBe(0);

    state.mode = "completed";
    const capture = { calls: 0, payloadJson: undefined as string | undefined };
    const readyKernel = makeBackgroundKernel(async () => pool, makeStoreTool(capture, groupId, resultId));
    await readyKernel.run(collectProgram);
    const ready = readyKernel.consoleValues[0] as unknown as CollectView;
    expect(ready.state).toBe("ready");
    expect(ready.groupState).toBe("completed");
    expect(ready.counts).toEqual({ succeeded: 2, failed: 0, cancelled: 0 });
    expect(ready.path).toBe(path);
    expect(ready.payloadChars).toBeGreaterThan(0);
    expect(capture.calls).toBe(1);
    expect(capture.payloadJson).toBeDefined();
    expect(ready.checksum).toBe(sha256Hex(capture.payloadJson as string));

    const payload = JSON.parse(capture.payloadJson as string) as TaskGroupResultPayload;
    expect(payload.strategy).toBe("pool");
    expect(payload.groupState).toBe("completed");
    expect(payload.outcomes.map((outcome) => outcome.name)).toEqual(["alpha", "beta"]);
    expect(typeof payload.gateText).toBe("string");
    expect(payload.gateText).not.toContain(EVAL_RESULT_PROTOCOL);
    const expectedGate = runResultGate(payload.outcomes as TaskOutcome[], TWO_TASK_SPEC, { groupState: "completed" });
    expect(payload.gateText).toBe(expectedGate.deliveredText);
    expect(payload.gatedChars).toBe(expectedGate.deliveredChars);
  });

  test("collect writes a cancelled result through the write tool", async () => {
    const groupId = "tg-unittest-cancel";
    const resultId = "tgbg_0123456789abcdef";
    const path = "/tmp/mock-cancel-result.json";
    delete (globalThis as Record<string, unknown>)[REGISTRY];
    const state = { mode: "running" as "running" | "cancelled" };
    const { pool } = makePool(groupId, state);
    const dispatchKernel = makeBackgroundKernel(async () => pool);
    await dispatchKernel.run(
      compilePoolBackgroundDispatchProgram(TWO_TASK_SPEC, { groupId, background: { resultId } }),
    );
    state.mode = "cancelled";
    const capture = { calls: 0, payloadJson: undefined as string | undefined };
    const kernel = makeBackgroundKernel(async () => pool, makeStoreTool(capture, groupId, resultId));
    await kernel.run(
      compilePoolBackgroundCollectProgram(TWO_TASK_SPEC, {
        groupId,
        collect: { resultId, path, storeCapability: "a".repeat(64) },
      }),
    );
    const ready = kernel.consoleValues[0] as unknown as CollectView;
    expect(ready.state).toBe("ready");
    expect(ready.groupState).toBe("cancelled");
    expect(ready.counts).toEqual({ succeeded: 0, failed: 0, cancelled: 2 });
    expect(capture.calls).toBe(1);
    const payload = JSON.parse(capture.payloadJson as string) as TaskGroupResultPayload;
    expect(payload.groupState).toBe("cancelled");
    expect(payload.outcomes.map((outcome) => outcome.status)).toEqual(["cancelled", "cancelled"]);
    expect(String(payload.gateText)).toContain("Task Group cancelled");
  });

  test("collect accepts a logical item failure inside a completed Workpool item", async () => {
    const groupId = "tg-unittest-partial";
    const resultId = "tgbg_0123456789abcdef";
    const path = "/tmp/mock-partial-result.json";
    delete (globalThis as Record<string, unknown>)[REGISTRY];
    const pushed: string[] = [];
    const pool = {
      async push(...prompts: string[]) {
        pushed.push(...prompts);
        return prompts.map((_, index) => `${groupId}#${index + 1}`);
      },
      async status() {
        return {
          name: groupId,
          closed: pushed.length > 0,
          batches: pushed.length > 0 ? 1 : 0,
          agents: ["sonic"],
          items: {
            queued: 0,
            running: 0,
            completed: pushed.length > 0 ? 2 : 0,
            failed: 0,
            cancelled: 0,
          },
        };
      },
      async peek() {
        if (pushed.length === 0) return { pending: 0, batches: [] };
        return {
          pending: 0,
          batches: [
            {
              id: "b1",
              agent: "sonic",
              status: "completed",
              items: [`${groupId}#1`, `${groupId}#2`],
              output: JSON.stringify({
                [`${groupId}#1`]: JSON.stringify({ status: "succeeded", value: "one" }),
                [`${groupId}#2`]: JSON.stringify({ error: "child failed logically" }),
              }),
            },
          ],
        };
      },
      async close() {
        return { dropped: [] as string[] };
      },
    };
    const dispatchKernel = makeBackgroundKernel(async () => pool);
    await dispatchKernel.run(
      compilePoolBackgroundDispatchProgram(TWO_TASK_SPEC, { groupId, background: { resultId } }),
    );
    const capture = { calls: 0, payloadJson: undefined as string | undefined };
    const kernel = makeBackgroundKernel(async () => pool, makeStoreTool(capture, groupId, resultId));
    await kernel.run(
      compilePoolBackgroundCollectProgram(TWO_TASK_SPEC, {
        groupId,
        collect: { resultId, path, storeCapability: "a".repeat(64) },
      }),
    );
    const ready = kernel.consoleValues[0] as unknown as CollectView;
    expect(ready.state).toBe("ready");
    expect(ready.groupState).toBe("completed");
    expect(ready.counts).toEqual({ succeeded: 1, failed: 1, cancelled: 0 });
    const payload = JSON.parse(capture.payloadJson as string) as TaskGroupResultPayload;
    expect(payload.outcomes.map((outcome) => outcome.status)).toEqual(["succeeded", "failed"]);
    delete (globalThis as Record<string, unknown>)[REGISTRY];
  });

  test("collect keeps JSON-object string results as text and preserves raw structured values", async () => {
    const groupId = "tg-unittest-json";
    const resultId = "tgbg_0123456789abcdef";
    const path = "/tmp/mock-json-result.json";
    delete (globalThis as Record<string, unknown>)[REGISTRY];
    const literal = JSON.stringify({ stdout: "captured output", wallTime: "5 seconds", files: ["child.started"] });
    const structuredValue = { stdout: "structured output", wallTime: "2 seconds", files: [] as string[] };
    let pushed = false;
    const pool = {
      async push(...prompts: string[]) {
        pushed = true;
        return prompts.map((_, index) => `${groupId}#${index + 1}`);
      },
      async status() {
        return {
          name: groupId,
          closed: pushed,
          batches: pushed ? 1 : 0,
          agents: ["sonic"],
          items: pushed
            ? { queued: 0, running: 0, completed: 2, failed: 0, cancelled: 0 }
            : { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 },
        };
      },
      async peek() {
        if (!pushed) return { pending: 0, batches: [] };
        return {
          pending: 0,
          batches: [
            {
              id: "b1",
              agent: "sonic",
              status: "completed",
              items: [`${groupId}#1`, `${groupId}#2`],
              output: JSON.stringify({
                [`${groupId}#1`]: literal,
                [`${groupId}#2`]: structuredValue,
              }),
            },
          ],
        };
      },
      async close() {
        return { dropped: [] as string[] };
      },
    };
    const dispatchKernel = makeBackgroundKernel(async () => pool);
    await dispatchKernel.run(
      compilePoolBackgroundDispatchProgram(TWO_TASK_SPEC, { groupId, background: { resultId } }),
    );
    const capture = { calls: 0, payloadJson: undefined as string | undefined };
    const kernel = makeBackgroundKernel(async () => pool, makeStoreTool(capture, groupId, resultId));
    await kernel.run(
      compilePoolBackgroundCollectProgram(TWO_TASK_SPEC, {
        groupId,
        collect: { resultId, path, storeCapability: "a".repeat(64) },
      }),
    );
    const ready = kernel.consoleValues[0] as unknown as CollectView;
    expect(ready.state).toBe("ready");
    expect(ready.groupState).toBe("completed");
    expect(ready.counts).toEqual({ succeeded: 2, failed: 0, cancelled: 0 });
    const payload = JSON.parse(capture.payloadJson as string) as TaskGroupResultPayload;
    expect(payload.outcomes[0]).toMatchObject({ status: "succeeded", result: literal });
    expect(payload.outcomes[0]?.structured).toBeUndefined();
    expect(payload.outcomes[1]).toMatchObject({ status: "succeeded", structured: structuredValue });
    expect(payload.outcomes[1]?.result).toBeUndefined();
    delete (globalThis as Record<string, unknown>)[REGISTRY];
  });

  test("collect surfaces a native failed batch diagnostic instead of a generic message", async () => {
    const groupId = "tg-unittest-batch-fail";
    const resultId = "tgbg_0123456789abcdef";
    const path = "/tmp/mock-batch-fail-result.json";
    delete (globalThis as Record<string, unknown>)[REGISTRY];
    let pushed = false;
    const pool = {
      async push(...prompts: string[]) {
        pushed = true;
        return prompts.map((_, index) => `${groupId}#${index + 1}`);
      },
      async status() {
        return {
          name: groupId,
          closed: pushed,
          batches: pushed ? 1 : 0,
          agents: ["sonic"],
          items: pushed
            ? { queued: 0, running: 0, completed: 0, failed: 2, cancelled: 0 }
            : { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 },
        };
      },
      async peek() {
        if (!pushed) return { pending: 0, batches: [] };
        return {
          pending: 0,
          batches: [
            {
              id: "b1",
              agent: "sonic",
              status: "failed",
              items: [`${groupId}#1`, `${groupId}#2`],
              output: "worker crashed: ENOENT /tmp/x",
            },
          ],
        };
      },
      async close() {
        return { dropped: [] as string[] };
      },
    };
    const dispatchKernel = makeBackgroundKernel(async () => pool);
    await dispatchKernel.run(
      compilePoolBackgroundDispatchProgram(TWO_TASK_SPEC, { groupId, background: { resultId } }),
    );
    const capture = { calls: 0, payloadJson: undefined as string | undefined };
    const kernel = makeBackgroundKernel(async () => pool, makeStoreTool(capture, groupId, resultId));
    await kernel.run(
      compilePoolBackgroundCollectProgram(TWO_TASK_SPEC, {
        groupId,
        collect: { resultId, path, storeCapability: "a".repeat(64) },
      }),
    );
    const ready = kernel.consoleValues[0] as unknown as CollectView;
    expect(ready.state).toBe("ready");
    expect(ready.groupState).toBe("failed");
    expect(ready.counts).toEqual({ succeeded: 0, failed: 2, cancelled: 0 });
    const payload = JSON.parse(capture.payloadJson as string) as TaskGroupResultPayload;
    expect(payload.groupState).toBe("failed");
    expect(payload.outcomes.map((outcome) => outcome.error)).toEqual([
      "worker crashed: ENOENT /tmp/x",
      "worker crashed: ENOENT /tmp/x",
    ]);
    delete (globalThis as Record<string, unknown>)[REGISTRY];
  });

  test("collect fails closed on a lost handle or a malformed snapshot", async () => {
    const groupId = "tg-unittest-fail";
    const resultId = "tgbg_0123456789abcdef";
    const dir = mkdtempSync(join(tmpdir(), "tg-bg-fail-unittest-"));
    const path = join(dir, "result.json");
    delete (globalThis as Record<string, unknown>)[REGISTRY];
    try {
      const state = { mode: "running" as "running" | "completed" };
      const { pool } = makePool(groupId, state);
      const dispatchKernel = makeBackgroundKernel(async () => pool);
      await dispatchKernel.run(
        compilePoolBackgroundDispatchProgram(TWO_TASK_SPEC, { groupId, background: { resultId } }),
      );

      // Lost kernel handle: dispatch ran, registry no longer has the entry.
      delete (globalThis as Record<string, unknown>)[REGISTRY];
      const lostKernel = makeBackgroundKernel(async () => pool);
      await lostKernel.run(
        compilePoolBackgroundCollectProgram(TWO_TASK_SPEC, {
          groupId,
          collect: { resultId, path, storeCapability: "a".repeat(64) },
        }),
      );
      const lost = lostKernel.consoleValues[0] as unknown as CollectView;
      expect(lost.state).toBe("failed");
      expect(lost.stage).toBe("handle");
      expect(readFileExists(path)).toBe(false);

      // Malformed drained snapshot: status counts disagree with peek, so
      // collect must not write a partial result. Re-register with a good pool,
      // then swap the retained handle's pool for the malformed one.
      delete (globalThis as Record<string, unknown>)[REGISTRY];
      state.mode = "completed";
      const badPool = {
        ...pool,
        async status() {
          return {
            name: groupId,
            closed: true,
            batches: 1,
            agents: ["sonic"],
            items: { queued: 0, running: 0, completed: 5, failed: 0, cancelled: 0 },
          };
        },
      };
      const { pool: goodPool } = makePool(groupId, { mode: "completed" });
      const goodDispatch = makeBackgroundKernel(async () => goodPool);
      await goodDispatch.run(
        compilePoolBackgroundDispatchProgram(TWO_TASK_SPEC, { groupId, background: { resultId } }),
      );
      const registry = (globalThis as Record<string, unknown>)[REGISTRY] as {
        groups: Map<string, { pool: unknown }>;
      };
      const entry = registry.groups.get(groupId);
      expect(entry).toBeDefined();
      if (entry !== undefined) entry.pool = badPool;
      const badKernel = makeBackgroundKernel(async () => goodPool);
      await badKernel.run(
        compilePoolBackgroundCollectProgram(TWO_TASK_SPEC, {
          groupId,
          collect: { resultId, path, storeCapability: "a".repeat(64) },
        }),
      );
      const bad = badKernel.consoleValues[0] as unknown as CollectView;
      expect(bad.state).toBe("failed");
      expect(bad.stage).toBe("decode");
      expect(bad.reason).toContain("do not cover");
      expect(readFileExists(path)).toBe(false);
    } finally {
      delete (globalThis as Record<string, unknown>)[REGISTRY];
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function readFileExists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}
