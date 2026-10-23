import { describe, expect, test } from "bun:test";
import { compileFanoutProgram, compilePoolProgram, DISPLAY_PROTOCOL } from "../../src/compiler/program";
import { validateSpec } from "../../src/schema/task-group";
import type { TaskGroupSpec } from "../../src/schema/task-group";

/**
 * Executable transport test: run the compiled program inside a MOCKED eval
 * kernel (public-prelude-shaped stubs: agent / wait / completion / workpool /
 * display / phase / tool.hub) and verify the single structured display()
 * result end-to-end — protocol payload, inline per-task results, clipping,
 * join/cancel semantics. This is the test class that catches program-level
 * crashes that syntax checks cannot see (e.g. a lost declaration).
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

interface DisplayPayload {
  protocol: string;
  groupId: string;
  strategy: string;
  groupState: string;
  rawChildChars: number;
  outcomes: Outcome[];
  groupError?: string;
  summary?: string;
  summaryError?: string;
}

interface MockKernel {
  displays: unknown[];
  phases: string[];
  completionPrompts: string[];
  run(program: string): Promise<void>;
}

type FnMap = Record<string, unknown>;

/** Execute a compiled program inside an arbitrary prelude fn map. */
function installRunner(kernel: MockKernel, fns: FnMap): void {
  fns.display = (value: unknown) => {
    kernel.displays.push(value);
  };
  fns.phase = (title: string) => {
    kernel.phases.push(String(title));
  };
  kernel.run = (program: string) => {
    const fn = new Function(
      "agent", "wait", "completion", "workpool", "display", "phase", "tool",
      `return async () => {\n${program}\n}`,
    ) as (...args: unknown[]) => () => Promise<void>;
    const runner = fn(fns.agent, fns.wait, fns.completion, fns.workpool, fns.display, fns.phase, fns.tool);
    return runner();
  };
}

/** Assemble a mocked prelude and execute one compiled program inside it. */
function makeKernel(results: Array<unknown>): MockKernel {
  const kernel: MockKernel = { displays: [], phases: [], completionPrompts: [], run: async () => {} };
  const fns: FnMap = {};
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
  fns.tool = { hub: async () => ({ text: "", details: { jobs: [] } }) };
  installRunner(kernel, fns);
  return kernel;
}

function lastDisplay(kernel: MockKernel): DisplayPayload {
  expect(kernel.displays).toHaveLength(1);
  return kernel.displays[0] as DisplayPayload;
}

function byName(payload: DisplayPayload, name: string): Outcome {
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
  test("fanout all+collect: single display() with the full structured payload", async () => {
    const { kernel } = await runFanout(SPEC3, "tg-exec", ["res-0", "res-1", "res-2"]);
    const payload = lastDisplay(kernel);
    expect(payload.protocol).toBe(DISPLAY_PROTOCOL);
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

  test("structured child values ride inline in outcomes", async () => {
    const obj = { verdict: "ok", scores: [1, 2, 3] };
    const { kernel } = await runFanout(SPEC3, "tg-str", [obj, "text-1", "text-2"]);
    const payload = lastDisplay(kernel);
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
    const payload = lastDisplay(kernel);
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
    const kernel: MockKernel = { displays: [], phases: [], completionPrompts: [], run: async () => {} };
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
      tool: { hub: async () => ({ text: "", details: { jobs: [] } }) },
    };
    installRunner(kernel, fns);
    await kernel.run(program);
    const payload = lastDisplay(kernel);
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

  test("failures classify as failed/cancelled with errors, group completes (collect)", async () => {
    const { kernel } = await runFanout(SPEC3, "tg-fail", ["fine", new Error("boom-1"), new Error("cancel: interrupted")]);
    const payload = lastDisplay(kernel);
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

  test("summarize mode runs completion() over inline results and reports summary", async () => {
    const spec = validateSpec({
      ...SPEC3,
      output: { mode: "summarize", perTaskChars: 1200, maxTotalChars: 4000, preserveHandles: true },
    } as unknown as Record<string, unknown>);
    const { kernel } = await runFanout(spec, "tg-sum", ["alpha-res", "beta-res", "gamma-res"], {
      summarize: { model: "smol" },
    });
    const payload = lastDisplay(kernel);
    expect(payload.summary).toBe("digest-mock");
    expect(payload.summaryError).toBeUndefined();
    expect(kernel.phases).toContain("summarizing");
    // Corpus is fed by the inline per-task results (no side channel).
    expect(kernel.completionPrompts).toHaveLength(1);
    expect(kernel.completionPrompts[0]).toContain("alpha-res");
    expect(kernel.completionPrompts[0]).toContain("gamma-res");
  });

  test("pool program executes and recovers aggregate items into outcomes", async () => {
    const spec = validateSpec({
      context: "Ctx",
      join: { mode: "all" },
      tasks: [
        { name: "w0", agent: "sonic", task: "W0" },
        { name: "w1", agent: "sonic", task: "W1" },
        { name: "w2", agent: "sonic", task: "W2" },
        { name: "w3", agent: "sonic", task: "W3" },
        { name: "w4", agent: "sonic", task: "W4" },
        { name: "w5", agent: "sonic", task: "W5" },
      ],
    });
    const program = compilePoolProgram(spec, { groupId: "tg-pool" });
    const kernel: MockKernel = { displays: [], phases: [], completionPrompts: [], run: async () => {} };
    const aggregateText = [
      "Pool `tg-pool` completed — 6/6 items.",
      ...spec.tasks.map((_t, i) => `- [tg-pool#${i + 1}] completed — task ${i}\n\`\`\`json\n{"tg-pool#${i + 1}":"pool-res-${i}"}\n\`\`\``),
    ].join("\n");
    const pool = {
      name: "tg-pool",
      status: async () => ({ closed: true, items: { queued: 0, running: 0, completed: 6, failed: 0, cancelled: 0 }, agents: [] }),
      push: (...items: unknown[]) => items.map((_, i) => `tg-pool#${i + 1}`),
      close: async () => {},
    };
    const tool = {
      hub: async (args: { op: string }) =>
        args.op === "wait" ? { text: aggregateText } : { text: "", details: { jobs: [] } },
    };
    const fns: FnMap = {
      agent: async () => {
        throw new Error("no agent in pool");
      },
      wait: async () => [],
      completion: async () => ({ wait: async () => "d" }),
      workpool: async () => pool,
      tool,
    };
    installRunner(kernel, fns);
    await kernel.run(program);
    const payload = lastDisplay(kernel);
    expect(payload.protocol).toBe(DISPLAY_PROTOCOL);
    expect(payload.groupId).toBe("tg-pool");
    expect(payload.strategy).toBe("pool");
    expect(payload.groupState).toBe("completed");
    expect(payload.outcomes).toHaveLength(6);
    for (let i = 0; i < 6; i++) {
      const o = byName(payload, `w${i}`);
      expect(o.status).toBe("succeeded");
      expect(o.result).toBe(`pool-res-${i}`);
      expect(o.handle).toBe(`agent://tg-pool-${i + 1}`);
    }
    expect(payload.rawChildChars).toBe(60); // 6 × "pool-res-N" (10 chars)
    expect(kernel.phases.some((p) => p.includes("items pushed: 6"))).toBe(true);
    expect(kernel.phases.some((p) => p.includes("draining"))).toBe(true);
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
      { hub: async () => ({ text: "", details: { jobs: [] } }) },
    );

    await run();

    expect(settled).toBe(3);
    expect(logged).toHaveLength(1);
    const chunk = logged[0] as Record<string, unknown>;
    expect(chunk).toMatchObject({
      protocol: DISPLAY_PROTOCOL,
      groupId: "tg-console",
      transport: "omp-task-group/eval-result-view-v1",
      chunkIndex: 0,
      chunkCount: 1,
    });
    expect(typeof chunk.data).toBe("string");
    const payload = JSON.parse(chunk.data as string) as DisplayPayload;
    expect(payload.groupState).toBe("completed");
    expect(payload.outcomes.map((outcome) => outcome.name).sort()).toEqual(["p0", "p1", "p2"]);
  });

});
