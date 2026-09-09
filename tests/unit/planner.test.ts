import { describe, expect, test } from "bun:test";
import { planExecution } from "../../src/engine/planner";
import { validateSpec } from "../../src/schema/task-group";
import type { BackendCapabilities } from "../../src/backend/interface";

const CAPS: BackendCapabilities = {
  fanout: true,
  workpool: true,
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
    expect(plan.fallbackReason).toBe("workpool capability unavailable");
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

  test("decision trace is human-readable", () => {
    const spec = validateSpec({ ...HOMOGENEOUS });
    const plan = planExecution(spec, CAPS, { enabled: "auto", threshold: 6 });
    expect(plan.reasons.join("\n")).toContain("tasks: 8");
    expect(plan.reasons.join("\n")).toContain("scout");
    expect(plan.reasons.join("\n")).toContain("join: all");
  });
});
