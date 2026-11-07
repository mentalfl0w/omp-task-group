import { describe, expect, test } from "bun:test";
import type { BackendCapabilities, TaskGroupBackend } from "../../src/backend/interface";
import { defaultConfig } from "../../src/config";
import type { PlanResult } from "../../src/engine/planner";
import { runTaskGroup, type TelemetryGroupEntry } from "../../src/engine/runner";
import { validateSpec } from "../../src/schema/task-group";

describe("Task Group runtime plan", () => {
  test("records actual Fanout strategy and reason after pre-dispatch Pool fallback", async () => {
    const spec = validateSpec({
      context: "shared context",
      tasks: [
        { name: "alpha", agent: "sonic", task: "A" },
        { name: "beta", agent: "sonic", task: "B" },
      ],
    });
    const capabilities: BackendCapabilities = {
      fanout: true,
      workpool: true,
      taskGroupPool: true,
      summarize: false,
      structured: true,
      joinAll: true,
      joinAny: true,
      joinQuorum: true,
      rpcUi: false,
      notes: [],
    };
    const backend: TaskGroupBackend = {
      capabilities: () => capabilities,
      runGroup: async () => ({
        groupId: "tg-runtime-fallback",
        strategy: "fanout",
        fallbackReason: "caller has another waitable job",
        outcomes: [
          { name: "alpha", agent: "sonic", status: "succeeded", result: "A" },
          { name: "beta", agent: "sonic", status: "succeeded", result: "B" },
        ],
        rawChildChars: 2,
      }),
    };
    const planned: PlanResult = { strategy: "pool", reasons: ["pool candidate"], concurrency: "auto" };
    const telemetry: TelemetryGroupEntry[] = [];

    const result = await runTaskGroup({
      spec,
      config: defaultConfig(),
      backend,
      signal: undefined,
      onUpdate: undefined,
      telemetry: { recordGroup: (entry) => telemetry.push(entry) },
      groupId: "tg-runtime-fallback",
      plan: planned,
    });

    expect(result.plan.strategy).toBe("fanout");
    expect(result.plan.fallbackReason).toBe("caller has another waitable job");
    expect(result.plan.reasons).toContain("runtime fallback: caller has another waitable job");
    expect(result.snapshot.strategy).toBe("fanout");
    expect(result.snapshot.fallbackReason).toBe("caller has another waitable job");
    expect(result.text).toContain("Task Group ✓ · 2/2 succeeded · fanout");
    expect(telemetry).toHaveLength(1);
    expect(telemetry[0]).toMatchObject({ strategy: "fanout", fallbackReason: "caller has another waitable job" });
  });

  test("uses the in-cell gate text from a background payload instead of re-gating", async () => {
    const spec = validateSpec({
      context: "shared context",
      tasks: [
        { name: "alpha", agent: "sonic", task: "A" },
        { name: "beta", agent: "sonic", task: "B" },
      ],
    });
    const capabilities: BackendCapabilities = {
      fanout: true,
      workpool: false,
      taskGroupPool: false,
      summarize: false,
      structured: true,
      joinAll: true,
      joinAny: true,
      joinQuorum: true,
      rpcUi: false,
      notes: [],
    };
    const gateText = "Task Group completed\n\n✓ alpha · sonic\nCELL GATE";
    const backend: TaskGroupBackend = {
      capabilities: () => capabilities,
      runGroup: async () => ({
        groupId: "tg-cell-gate",
        strategy: "fanout",
        outcomes: [
          { name: "alpha", agent: "sonic", status: "succeeded", result: "A" },
          { name: "beta", agent: "sonic", status: "succeeded", result: "B" },
        ],
        rawChildChars: 2,
        gateText,
        gateMode: "compact",
        gateDeliveredChars: gateText.length,
      }),
    };
    const result = await runTaskGroup({
      spec,
      config: defaultConfig(),
      backend,
      signal: undefined,
      onUpdate: undefined,
      telemetry: { recordGroup: () => {} },
      groupId: "tg-cell-gate",
    });
    expect(result.text).toContain("CELL GATE");
    expect(result.text).toContain("Task Group ✓ · 2/2 succeeded · fanout");
    expect(result.gateMode).toBe("compact");
    expect(result.details.gate).toBe("compact");
  });

  test("surfaces an in-cell gate failure as an error instead of a success summary", async () => {
    const spec = validateSpec({
      context: "shared context",
      tasks: [
        { name: "alpha", agent: "sonic", task: "A" },
        { name: "beta", agent: "sonic", task: "B" },
      ],
    });
    const capabilities: BackendCapabilities = {
      fanout: true,
      workpool: false,
      taskGroupPool: false,
      summarize: false,
      structured: true,
      joinAll: true,
      joinAny: true,
      joinQuorum: true,
      rpcUi: false,
      notes: [],
    };
    const gateText = "Result gate failed for Task Group completed: necessary task metadata exceeds maxTotalChars";
    const gateError = "necessary task metadata requires 900 characters but maxTotalChars is 500";
    const backend: TaskGroupBackend = {
      capabilities: () => capabilities,
      runGroup: async () => ({
        groupId: "tg-cell-gate-failure",
        strategy: "fanout",
        outcomes: [
          { name: "alpha", agent: "sonic", status: "succeeded", result: "A" },
          { name: "beta", agent: "sonic", status: "succeeded", result: "B" },
        ],
        rawChildChars: 2,
        gateText,
        gateMode: "compact",
        gateDeliveredChars: gateText.length,
        gateError,
      }),
    };
    const result = await runTaskGroup({
      spec,
      config: defaultConfig(),
      backend,
      signal: undefined,
      onUpdate: undefined,
      telemetry: { recordGroup: () => {} },
      groupId: "tg-cell-gate-failure",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toBe(gateText);
    expect(result.text).not.toContain("Task Group ✓");
    expect(result.details.gateError).toBe(gateError);
    expect(result.snapshot.state).toBe("completed");
  });
});
