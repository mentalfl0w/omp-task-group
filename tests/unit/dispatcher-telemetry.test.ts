import { describe, expect, test } from "bun:test";
import { Telemetry, emptyAggregate } from "../../src/telemetry/metrics";
import { MissedGroupDetector } from "../../src/dispatcher/missed-group";
import { injectPolicy, DISPATCH_POLICY } from "../../src/dispatcher/policy";
import { defaultConfig, type TaskGroupConfig } from "../../src/config";
import type { TelemetryGroupEntry } from "../../src/engine/runner";

function entry(partial: Partial<TelemetryGroupEntry>): TelemetryGroupEntry {
  return {
    groupId: "tg1",
    strategy: "fanout",
    join: { mode: "all" },
    failure: { mode: "collect" },
    taskCount: 4,
    succeeded: 4,
    failed: 0,
    cancelled: 0,
    rawChildChars: 8000,
    deliveredChars: 1200,
    groupDurationMs: 9000,
    estimatedWakesAvoided: 3,
    planReasons: [],
    ...partial,
  };
}

describe("telemetry", () => {
  test("aggregate computes wake amplification + output reduction", () => {
    const t = new Telemetry(undefined);
    t.recordGroup(entry({}));
    t.recordGroup(entry({ groupId: "tg2", taskCount: 10, estimatedWakesAvoided: 9, strategy: "pool" }));
    expect(t.aggregate.groups).toBe(2);
    expect(t.aggregate.childExecutions).toBe(14);
    expect(t.aggregate.logicalDeliveries).toBe(2);
    expect(t.wakeAmplification).toBeCloseTo(2 / 14, 5);
    expect(t.aggregate.estimatedWakesAvoided).toBe(12);
    expect(t.outputReduction).toBeCloseTo(1 - 2400 / 16000, 5);
    expect(t.aggregate.poolSelections).toBe(1);
  });

  test("rehydrate merges persisted session entries", () => {
    const t = new Telemetry(undefined);
    t.rehydrate([
      { type: "custom", customType: "omp-task-group.telemetry.v1", data: entry({ groupId: "tg-old" }) },
      { type: "custom", customType: "omp-task-group.telemetry.v1", data: { kind: "missed_group_candidate" } },
      { type: "custom", customType: "other", data: { ignored: true } },
    ]);
    expect(t.aggregate.groups).toBe(1);
    expect(t.aggregate.missedGroupCandidates).toBe(1);
  });

  test("persistence goes through appendEntry (best-effort)", () => {
    let appended = 0;
    const t = new Telemetry(() => {
      appended += 1;
    });
    t.recordGroup(entry({}));
    expect(appended).toBe(1);
  });
});

describe("missed group detector", () => {
  function make(config?: Partial<TaskGroupConfig>) {
    const cfg = { ...defaultConfig(), ...config };
    let candidates = 0;
    const detector = new MissedGroupDetector(cfg, () => {
      candidates += 1;
    });
    return { detector, get: () => candidates };
  }

  test("two task calls in one turn → one candidate", () => {
    const { detector, get } = make();
    detector.onTurnStart();
    detector.onToolExecutionStart("task", "c1");
    expect(get()).toBe(0);
    detector.onToolExecutionStart("task", "c2");
    expect(get()).toBe(1);
    detector.onToolExecutionStart("task", "c3");
    expect(get()).toBe(1); // first detection only
  });

  test("other tools do not trigger", () => {
    const { detector, get } = make();
    detector.onTurnStart();
    detector.onToolExecutionStart("read", "c1");
    detector.onToolExecutionStart("grep", "c2");
    expect(get()).toBe(0);
  });

  test("disabled telemetry suppresses detection", () => {
    const cfg = defaultConfig();
    cfg.telemetry.detectMissedGroups = false;
    const { detector, get } = make(cfg);
    detector.onTurnStart();
    detector.onToolExecutionStart("task", "c1");
    detector.onToolExecutionStart("task", "c2");
    expect(get()).toBe(0);
  });

  test("state resets between turns", () => {
    const { detector, get } = make();
    detector.onTurnStart();
    detector.onToolExecutionStart("task", "c1");
    detector.onTurnEnd();
    detector.onTurnStart();
    detector.onToolExecutionStart("task", "c2");
    expect(get()).toBe(0);
  });
});

describe("smart dispatcher policy", () => {
  test("suggest mode injects the policy text", () => {
    const cfg = defaultConfig();
    const result = injectPolicy({ systemPrompt: ["base"] }, cfg);
    expect(result?.systemPrompt).toEqual(["base", DISPATCH_POLICY]);
  });

  test("off mode injects nothing", () => {
    const cfg = defaultConfig();
    cfg.dispatcher.mode = "off";
    expect(injectPolicy({ systemPrompt: ["base"] }, cfg)).toBeUndefined();
  });

  test("policy text covers all three routes and is short", () => {
    expect(DISPATCH_POLICY).toContain("task");
    expect(DISPATCH_POLICY).toContain("ompTaskGroup");
    expect(DISPATCH_POLICY).toContain("swarm");
    expect(DISPATCH_POLICY.length).toBeLessThan(1200);
  });

  test("unset systemPrompt tolerated", () => {
    const result = injectPolicy({ systemPrompt: undefined as unknown as string[] }, defaultConfig());
    expect(result?.systemPrompt).toEqual([DISPATCH_POLICY]);
  });

  test("emptyAggregate is all zeros", () => {
    const a = emptyAggregate();
    expect(a.groups).toBe(0);
    expect(a.childExecutions).toBe(0);
  });
});
