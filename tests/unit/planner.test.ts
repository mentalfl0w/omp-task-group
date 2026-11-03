import { describe, expect, test } from "bun:test";
import { planExecution } from "../../src/engine/planner";
import { validateSpec } from "../../src/schema/task-group";
import type { BackendCapabilities } from "../../src/backend/interface";

const CAPS: BackendCapabilities = {
  fanout: true,
  workpool: true,
  taskGroupPool: true,
  summarize: true,
  structured: true,
  joinAll: true,
  joinAny: true,
  joinQuorum: true,
  rpcUi: false,
  notes: [],
};

const HOMOGENEOUS = {
  context: "c",
  tasks: Array.from({ length: 8 }, (_, i) => ({ name: `t${i}`, agent: "scout", task: `do ${i}` })),
};

describe("planner", () => {
  test("auto → fanout for small heterogeneous groups", () => {
    const spec = validateSpec({
      context: "c",
      tasks: [
        { name: "a", agent: "scout", task: "a" },
        { name: "b", agent: "reviewer", task: "b" },
      ],
    });
    const plan = planExecution(spec, CAPS, { enabled: "auto", threshold: 6 });
    expect(plan.strategy).toBe("fanout");
    expect(plan.reasons.join("\n")).toContain("heterogeneous or below pool threshold");
  });

  test("large heterogeneous Fanout is not counted as a Pool fallback", () => {
    const tasks = HOMOGENEOUS.tasks.map((task, index) =>
      index === HOMOGENEOUS.tasks.length - 1 ? { ...task, agent: "reviewer" } : task,
    );
    const spec = validateSpec({ ...HOMOGENEOUS, tasks });
    const plan = planExecution(spec, CAPS, { enabled: "auto", threshold: 6 });
    expect(plan.strategy).toBe("fanout");
    expect(plan.fallbackReason).toBeUndefined();
    expect(plan.reasons.join("\n")).not.toContain("Pool candidate downgraded");
  });

  test("auto → pool for large homogeneous all+collect groups", () => {
    const spec = validateSpec({ ...HOMOGENEOUS, join: { mode: "all" } });
    const plan = planExecution(spec, CAPS, { enabled: "auto", threshold: 6 });
    expect(plan.strategy).toBe("pool");
    expect(plan.fallbackReason).toBeUndefined();
  });

  test("non-all join never intends pool: plain fanout, no fallback reason", () => {
    const spec = validateSpec({ ...HOMOGENEOUS, join: { mode: "any" } });
    const plan = planExecution(spec, CAPS, { enabled: "auto", threshold: 6 });
    expect(plan.strategy).toBe("fanout");
    expect(plan.fallbackReason).toBeUndefined();
  });

  test("pool downgrades when workpool capability missing", () => {
    const spec = validateSpec({ ...HOMOGENEOUS });
    const plan = planExecution(spec, { ...CAPS, workpool: false }, { enabled: "auto", threshold: 6 });
    expect(plan.strategy).toBe("fanout");
    expect(plan.fallbackReason).toBe("native Workpool API unavailable");
  });
  test("native Workpool does not imply Task Group Pool is safe", () => {
    const spec = validateSpec({ ...HOMOGENEOUS });
    const plan = planExecution(spec, { ...CAPS, taskGroupPool: false }, { enabled: "auto", threshold: 6 });
    expect(plan.strategy).toBe("fanout");
    expect(plan.fallbackReason).toBe("Task Group Pool result/wait contract unavailable");
  });

  test("Pool downgrades before dispatch for unsupported per-task semantics", () => {
    const cases = [
      {
        spec: validateSpec({
          ...HOMOGENEOUS,
          tasks: HOMOGENEOUS.tasks.map((task) => ({ ...task, schema: { type: "object" } })),
        }),
        reason: "Pool cannot enforce per-task output schemas; use Fanout",
      },
      {
        spec: validateSpec({
          ...HOMOGENEOUS,
          tasks: HOMOGENEOUS.tasks.map((task) => ({ ...task, isolated: true })),
        }),
        reason: "Pool cannot preserve per-task worktree isolation; use Fanout",
      },
      {
        spec: validateSpec({ ...HOMOGENEOUS, execution: { strategy: "auto", concurrency: 2 } }),
        reason: "Pool follows task.maxConcurrency and cannot honor per-group execution.concurrency",
      },
    ];
    for (const { spec, reason } of cases) {
      const plan = planExecution(spec, CAPS, { enabled: "auto", threshold: 6 });
      expect(plan.strategy).toBe("fanout");
      expect(plan.fallbackReason).toBe(reason);
    }
  });

  test("explicit fanout never downgrades", () => {
    const spec = validateSpec({ ...HOMOGENEOUS, execution: { strategy: "fanout", concurrency: "auto" } });
    const plan = planExecution(spec, CAPS, { enabled: "auto", threshold: 6 });
    expect(plan.strategy).toBe("fanout");
    expect(plan.reasons.join("\n")).toContain("explicit");
  });

  test("pool disabled by config forces fanout", () => {
    const spec = validateSpec({ ...HOMOGENEOUS });
    const plan = planExecution(spec, CAPS, { enabled: "off", threshold: 6 });
    expect(plan.strategy).toBe("fanout");
  });

  test("explicit Pool disabled by config reports the downgrade reason", () => {
    const spec = validateSpec({
      ...HOMOGENEOUS,
      execution: { strategy: "pool", concurrency: "auto" },
    });
    const plan = planExecution(spec, CAPS, { enabled: "off", threshold: 6 });
    expect(plan.strategy).toBe("fanout");
    expect(plan.fallbackReason).toBe("Pool disabled by config");
    expect(plan.reasons.join("\n")).toContain("downgraded from pool: Pool disabled by config");
  });

  test("auto falls back before Pool dispatch when an Eval wrapper lacks the capability marker", () => {
    const spec = validateSpec({ ...HOMOGENEOUS });
    const reason =
      "1 Eval wrapper(s) do not declare omp-task-group-pool-proc-cancel:v1; Pool's proc cancellation policy is unknown, so using Fanout";
    const plan = planExecution(
      spec,
      { ...CAPS, taskGroupPool: false, taskGroupPoolReason: reason },
      { enabled: "auto", threshold: 6 },
    );
    expect(plan.strategy).toBe("fanout");
    expect(plan.fallbackReason).toBe(reason);
    expect(plan.reasons.join("\n")).toContain("Pool candidate downgraded: " + reason);
  });

  test("decision trace is human-readable", () => {
    const spec = validateSpec({ ...HOMOGENEOUS });
    const plan = planExecution(spec, CAPS, { enabled: "auto", threshold: 6 });
    expect(plan.reasons.join("\n")).toContain("tasks: 8");
    expect(plan.reasons.join("\n")).toContain("scout");
    expect(plan.reasons.join("\n")).toContain("join: all");
  });
});
