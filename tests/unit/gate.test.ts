import { describe, expect, test } from "bun:test";
import { runResultGate } from "../../src/result/gate";
import { validateSpec } from "../../src/schema/task-group";
import type { TaskOutcome } from "../../src/backend/interface";

const SPEC = validateSpec({
  context: "c",
  tasks: [
    { name: "a", agent: "scout", task: "a" },
    { name: "b", agent: "scout", task: "b" },
  ],
  output: { mode: "compact", perTaskChars: 100, maxTotalChars: 500, preserveHandles: true },
});

const OUTCOMES: TaskOutcome[] = [
  { name: "a", agent: "scout", status: "succeeded", handle: "agent://a", result: "x".repeat(300) },
  { name: "b", agent: "scout", status: "failed", error: "boom" },
];

describe("result gate", () => {
  test("compact clips per-task previews and keeps handles", () => {
    const gate = runResultGate(OUTCOMES, SPEC, { groupState: "completed" });
    expect(gate.mode).toBe("compact");
    expect(gate.deliveredText).toContain("✓ a · scout");
    expect(gate.deliveredText).toContain("Full result: agent://a");
    expect(gate.deliveredText).toContain("✗ b · scout");
    expect(gate.deliveredText).toContain("error: boom");
    expect(gate.deliveredChars).toBeLessThanOrEqual(500);
    // Raw 300 chars clipped under effective perTaskChars.
    const effective = Math.min(100, Math.max(100, Math.floor(400 / 2)));
    expect(gate.deliveredText).not.toContain("x".repeat(effective + 10));
  });

  test("structured mode aggregates JSON without a summarizer", () => {
    const spec = validateSpec({
      ...{ context: "c", tasks: [{ name: "a", agent: "s", task: "a" }, { name: "b", agent: "s", task: "b" }] },
      output: { mode: "structured", perTaskChars: 100, maxTotalChars: 2000, preserveHandles: true },
    });
    const outcomes: TaskOutcome[] = [
      { name: "a", agent: "s", status: "succeeded", structured: { verdict: "ok", n: 1 } },
      { name: "b", agent: "s", status: "succeeded", structured: { verdict: "ok", n: 2 } },
    ];
    const gate = runResultGate(outcomes, spec, { groupState: "completed" });
    expect(gate.mode).toBe("structured");
    const parsed = JSON.parse(gate.deliveredText) as { tasks: Array<{ name: string; result: unknown }> };
    expect(parsed.tasks).toHaveLength(2);
    expect(parsed.tasks[0]?.result).toMatchObject({ verdict: "ok" });
  });

  test("summarize mode uses provided summary with status lines", () => {
    const spec = validateSpec({
      context: "c",
      tasks: [
        { name: "a", agent: "s", task: "a" },
        { name: "b", agent: "s", task: "b" },
      ],
      output: { mode: "summarize", perTaskChars: 100, maxTotalChars: 2000, preserveHandles: true },
    });
    const gate = runResultGate(OUTCOMES, spec, { groupState: "completed", summary: "digest text" });
    expect(gate.mode).toBe("summarize");
    expect(gate.deliveredText).toContain("digest text");
    expect(gate.deliveredText).toContain("agent://a");
  });

  test("group errors are surfaced in delivered text", () => {
    const gate = runResultGate(OUTCOMES, SPEC, { groupState: "failed", groupError: "join exhausted" });
    expect(gate.deliveredText).toContain("group error: join exhausted");
  });

  test("maxTotalChars hard cap never exceeded", () => {
    const spec = validateSpec({
      context: "c",
      tasks: [
        { name: "a", agent: "s", task: "a" },
        { name: "b", agent: "s", task: "b" },
      ],
      output: { mode: "compact", perTaskChars: 300, maxTotalChars: 600, preserveHandles: false },
    });
    const gate = runResultGate(OUTCOMES, spec, { groupState: "completed" });
    expect(gate.deliveredChars).toBeLessThanOrEqual(600);
  });
});
