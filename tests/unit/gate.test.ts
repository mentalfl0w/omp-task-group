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

  test("compact keeps every status, failure preview, handle, and join result under long output", () => {
    const spec = validateSpec({
      context: "c",
      tasks: [
        { name: "a", agent: "scout", task: "a" },
        { name: "b", agent: "scout", task: "b" },
        { name: "c", agent: "scout", task: "c" },
        { name: "d", agent: "scout", task: "d" },
      ],
      output: { mode: "compact", perTaskChars: 100, maxTotalChars: 500, preserveHandles: true },
    });
    const outcomes: TaskOutcome[] = [
      { name: "a", agent: "scout", status: "succeeded", handle: "agent://a", result: "a".repeat(600) },
      { name: "b", agent: "scout", status: "failed", handle: "agent://b", error: "b".repeat(500) },
      { name: "c", agent: "scout", status: "cancelled", handle: "agent://c", error: "cancelled by join" },
      { name: "d", agent: "scout", status: "missing", handle: "agent://d", error: "no outcome recorded" },
    ];
    const gate = runResultGate(outcomes, spec, { groupState: "cancelled" });
    expect(gate.mode).toBe("compact");
    expect(gate.deliveredChars).toBe(gate.deliveredText.length);
    expect(gate.deliveredChars).toBeLessThanOrEqual(500);
    expect(gate.deliveredText).toContain("Task Group cancelled · join all · 1/4 succeeded · 1 failed · 1 cancelled · 1 missing");
    expect(gate.deliveredText).toContain("✓ a · scout");
    expect(gate.deliveredText).toContain("✗ b · scout");
    expect(gate.deliveredText).toContain("⊘ c · scout");
    expect(gate.deliveredText).toContain("… d · scout");
    expect(gate.deliveredText).toContain("error: bbbb");
    expect(gate.deliveredText).toContain("error: cancelled by join");
    expect(gate.deliveredText).toContain("error: no outcome recorded");
    expect(gate.deliveredText).toContain("Full result: agent://a");
    expect(gate.deliveredText).toContain("Full result: agent://b");
    expect(gate.deliveredText).toContain("Full result: agent://c");
    expect(gate.deliveredText).toContain("Full result: agent://d");
    // The long succeeded body is compressed, not the metadata.
    expect(gate.deliveredText).not.toContain("a".repeat(200));
  });

  test("compact surfaces a group error next to the join result instead of clipping it", () => {
    const gate = runResultGate(
      [
        { name: "a", agent: "scout", status: "succeeded", handle: "agent://a", result: "x".repeat(2000) },
        { name: "b", agent: "scout", status: "succeeded", handle: "agent://b", result: "y".repeat(2000) },
      ],
      SPEC,
      { groupState: "failed", groupError: "join exhausted after all waits settled" },
    );
    expect(gate.deliveredChars).toBeLessThanOrEqual(500);
    expect(gate.deliveredText).toContain("Task Group failed · join all · 2/2 succeeded");
    expect(gate.deliveredText).toContain("group error: join exhausted after all waits settled");
    expect(gate.deliveredText).toContain("Full result: agent://a");
    expect(gate.deliveredText).toContain("Full result: agent://b");
  });

  test("structured output stays valid JSON when large results are compressed", () => {
    const spec = validateSpec({
      context: "c",
      tasks: [
        { name: "a", agent: "s", task: "a" },
        { name: "b", agent: "s", task: "b" },
      ],
      output: { mode: "structured", perTaskChars: 100, maxTotalChars: 500, preserveHandles: true },
    });
    const outcomes: TaskOutcome[] = [
      { name: "a", agent: "s", status: "succeeded", handle: "agent://a", structured: { blob: "y".repeat(400) } },
      { name: "b", agent: "s", status: "failed", handle: "agent://b", error: "boom" },
    ];
    const gate = runResultGate(outcomes, spec, { groupState: "failed", groupError: "join unmet" });
    expect(gate.mode).toBe("structured");
    expect(gate.deliveredChars).toBeLessThanOrEqual(500);
    const parsed = JSON.parse(gate.deliveredText) as {
      group: string;
      groupError: string;
      tasks: Array<{ name: string; status: string; error?: string; handle?: string; result?: unknown }>;
    };
    expect(parsed.group).toBe("failed");
    expect(parsed.groupError).toBe("join unmet");
    expect(parsed.tasks).toHaveLength(2);
    expect(parsed.tasks[0]).toMatchObject({ name: "a", status: "succeeded", handle: "agent://a" });
    expect(parsed.tasks[1]).toMatchObject({ name: "b", status: "failed", error: "boom", handle: "agent://b" });
    expect(parsed.tasks[0]?.result).toMatchObject({ $truncated: expect.any(Number) });
  });

  test("structured keeps failure previews when long errors force compression", () => {
    const spec = validateSpec({
      context: "c",
      tasks: [
        { name: "a", agent: "s", task: "a" },
        { name: "b", agent: "s", task: "b" },
      ],
      output: { mode: "structured", perTaskChars: 100, maxTotalChars: 500, preserveHandles: true },
    });
    const outcomes: TaskOutcome[] = [
      { name: "a", agent: "s", status: "failed", error: "E".repeat(600) },
      { name: "b", agent: "s", status: "failed", error: "F".repeat(600) },
    ];
    const gate = runResultGate(outcomes, spec, { groupState: "failed", groupError: "join unmet" });
    expect(gate.deliveredChars).toBeLessThanOrEqual(500);
    const parsed = JSON.parse(gate.deliveredText) as {
      tasks: Array<{ name: string; status: string; error: string }>;
    };
    expect(parsed.tasks).toHaveLength(2);
    expect(parsed.tasks[0]?.error.startsWith("E")).toBe(true);
    expect(parsed.tasks[1]?.error.startsWith("F")).toBe(true);
    expect(parsed.tasks[0]?.error).toContain("chars]");
    expect(parsed.tasks[1]?.error).toContain("chars]");
  });

  test("structured output keeps small results and a partial-failure record", () => {
    const spec = validateSpec({
      context: "c",
      tasks: [
        { name: "a", agent: "s", task: "a" },
        { name: "b", agent: "s", task: "b" },
      ],
      output: { mode: "structured", perTaskChars: 100, maxTotalChars: 800, preserveHandles: true },
    });
    const outcomes: TaskOutcome[] = [
      { name: "a", agent: "s", status: "succeeded", handle: "agent://a", structured: { verdict: "ok", n: 1 } },
      { name: "b", agent: "s", status: "failed", handle: "agent://b", error: "boom" },
    ];
    const gate = runResultGate(outcomes, spec, { groupState: "failed", groupError: "join unmet" });
    const parsed = JSON.parse(gate.deliveredText) as {
      tasks: Array<{ name: string; status: string; result?: unknown; error?: string }>;
    };
    expect(parsed.tasks[0]?.result).toEqual({ verdict: "ok", n: 1 });
    expect(parsed.tasks[1]).toMatchObject({ status: "failed", error: "boom" });
  });

  test("summarize clips only the digest and keeps statuses, failures, handles, and group error", () => {
    const spec = validateSpec({
      context: "c",
      tasks: [
        { name: "a", agent: "s", task: "a" },
        { name: "b", agent: "s", task: "b" },
      ],
      output: { mode: "summarize", perTaskChars: 100, maxTotalChars: 700, preserveHandles: true },
    });
    const summary = "digest ".repeat(400);
    const outcomes: TaskOutcome[] = [
      { name: "a", agent: "s", status: "succeeded", handle: "agent://a", result: "a".repeat(2000) },
      { name: "b", agent: "s", status: "failed", handle: "agent://b", error: "boom" },
    ];
    const gate = runResultGate(outcomes, spec, {
      groupState: "failed",
      groupError: "join exhausted",
      summary,
    });
    expect(gate.mode).toBe("summarize");
    expect(gate.deliveredChars).toBeLessThanOrEqual(700);
    expect(gate.deliveredText).toContain("Task Group failed · join all · 1/2 succeeded · 1 failed");
    expect(gate.deliveredText).toContain("group error: join exhausted");
    expect(gate.deliveredText).toContain("✓ a · s");
    expect(gate.deliveredText).toContain("✗ b · s");
    expect(gate.deliveredText).toContain("error: boom");
    expect(gate.deliveredText).toContain("Full result: agent://a");
    expect(gate.deliveredText).toContain("Full result: agent://b");
    expect(gate.deliveredText).toContain("digest");
    expect(gate.deliveredText).not.toContain(summary);
    expect(gate.deliveredText).toContain("chars]");
  });

  test("clipping never splits a UTF-16 surrogate pair in any mode", () => {
    const emoji = "😀";
    const compactSpec = validateSpec({
      context: "c",
      tasks: [
        { name: "a", agent: "s", task: "a" },
        { name: "b", agent: "s", task: "b" },
      ],
      output: { mode: "compact", perTaskChars: 100, maxTotalChars: 500, preserveHandles: false },
    });
    const compact = runResultGate(
      [
        { name: "a", agent: "s", status: "succeeded", result: emoji.repeat(200) },
        { name: "b", agent: "s", status: "succeeded", result: emoji.repeat(200) },
      ],
      compactSpec,
      { groupState: "completed" },
    );
    expect(compact.deliveredChars).toBeLessThanOrEqual(500);
    expect(compact.deliveredText).toContain("chars]");
    expect(hasLoneSurrogate(compact.deliveredText)).toBe(false);

    const summarizeSpec = validateSpec({
      context: "c",
      tasks: [
        { name: "a", agent: "s", task: "a" },
        { name: "b", agent: "s", task: "b" },
      ],
      output: { mode: "summarize", perTaskChars: 100, maxTotalChars: 500, preserveHandles: false },
    });
    const summarized = runResultGate(
      [
        { name: "a", agent: "s", status: "succeeded", result: "a" },
        { name: "b", agent: "s", status: "succeeded", result: "b" },
      ],
      summarizeSpec,
      { groupState: "completed", summary: emoji.repeat(400) },
    );
    expect(summarized.deliveredChars).toBeLessThanOrEqual(500);
    expect(summarized.deliveredText).toContain("chars]");
    expect(hasLoneSurrogate(summarized.deliveredText)).toBe(false);
  });

  test("an impossible maxTotalChars fails explicitly instead of hiding metadata", () => {
    const tiny = { ...SPEC, output: { ...SPEC.output, maxTotalChars: 40 } };
    const outcomes: TaskOutcome[] = [
      { name: "a", agent: "scout", status: "succeeded", handle: `agent://${"h".repeat(100)}`, result: "x".repeat(50) },
      { name: "b", agent: "scout", status: "failed", handle: "agent://b", error: "boom" },
    ];
    const gate = runResultGate(outcomes, tiny, { groupState: "completed" });
    expect(gate.error).toBeDefined();
    expect(gate.error).toContain("necessary task metadata requires");
    expect(gate.error).toContain("maxTotalChars is 40");
    expect(gate.deliveredChars).toBeLessThanOrEqual(40);
    expect(gate.deliveredText).toContain("Result gate failed");
    expect(gate.deliveredText).not.toContain("agent://");
  });

  test("structured mode also fails explicitly with valid JSON under an impossible cap", () => {
    const tiny = { ...SPEC, output: { ...SPEC.output, mode: "structured" as const, maxTotalChars: 40 } };
    const outcomes: TaskOutcome[] = [
      { name: "a", agent: "scout", status: "succeeded", handle: "agent://a", structured: { blob: "z".repeat(100) } },
      { name: "b", agent: "scout", status: "failed", handle: "agent://b", error: "boom" },
    ];
    const gate = runResultGate(outcomes, tiny, { groupState: "completed" });
    expect(gate.mode).toBe("structured");
    expect(gate.error).toBeDefined();
    expect(gate.deliveredChars).toBeLessThanOrEqual(40);
    const parsed = JSON.parse(gate.deliveredText) as { gateError?: string };
    expect(typeof parsed.gateError).toBe("string");
  });

  test("a zero budget returns no fabricated text but reports the gate error", () => {
    const zero = { ...SPEC, output: { ...SPEC.output, maxTotalChars: 0 } };
    const gate = runResultGate(OUTCOMES, zero, { groupState: "completed" });
    expect(gate.deliveredText).toBe("");
    expect(gate.deliveredChars).toBe(0);
    expect(gate.error).toBeDefined();
  });
});

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return true;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}
