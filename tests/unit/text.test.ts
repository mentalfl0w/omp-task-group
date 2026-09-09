import { describe, expect, test } from "bun:test";
import { renderFinalText, renderSnapshotText, renderStatusLine, renderWidgetLines } from "../../src/presentation/text";
import { initialSnapshot, SnapshotReducer } from "../../src/engine/reducer";
import type { TaskGroupSnapshot } from "../../src/state/events";

function sampleSnapshot(): TaskGroupSnapshot {
  const snap = initialSnapshot("tg1", "research", "fanout", { mode: "all" }, { mode: "collect" }, [
    { name: "database", agent: "scout" },
    { name: "tests", agent: "scout" },
    { name: "security", agent: "reviewer" },
    { name: "api", agent: "scout" },
  ]);
  const r = new SnapshotReducer(snap);
  r.apply({
    type: "group_started",
    groupId: "tg1",
    label: "research",
    strategy: "fanout",
    join: { mode: "all" },
    failure: { mode: "collect" },
    taskNames: [
      { name: "database", agent: "scout" },
      { name: "tests", agent: "scout" },
      { name: "security", agent: "reviewer" },
      { name: "api", agent: "scout" },
    ],
    startedAtMs: Date.now(),
  });
  r.apply({ type: "task_state", name: "database", state: "running", handle: "agent://tg1-database" });
  r.apply({ type: "task_state", name: "tests", state: "running", handle: "agent://tg1-tests" });
  r.apply({ type: "task_state", name: "security", state: "succeeded", durationMs: 8200, resolvedModel: "opencode-go/deepseek-v4-flash:max" });
  return r.current;
}

describe("text presenter (parity source)", () => {
  test("running snapshot shows states + progress", () => {
    const text = renderSnapshotText(sampleSnapshot());
    expect(text).toContain("Task Group · all · fanout · research");
    expect(text).toContain("✓ security");
    expect(text).toContain("● database");
    expect(text).toContain("… api");
    expect(text).toContain("1 / 4 settled");
  });

  test("widget lines capped at 10 and semantically equal to text", () => {
    const snap = sampleSnapshot();
    const widget = renderWidgetLines(snap);
    expect(widget.length).toBeLessThanOrEqual(10);
    expect(widget.join("\n")).toContain("✓ security");
    expect(renderStatusLine(snap)).toBe("Task Group tg1: 1/4");
  });

  test("final text embeds delivered payload", () => {
    const snap = sampleSnapshot();
    const final = renderFinalText(snap, "DELIVERED_BODY");
    expect(final).toContain("DELIVERED_BODY");
    expect(final).toContain("Task Group");
  });
});
