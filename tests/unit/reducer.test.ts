import { describe, expect, test } from "bun:test";
import { SnapshotReducer, initialSnapshot } from "../../src/engine/reducer";
import type { GroupEvent } from "../../src/state/events";

type Join = { mode: "all" | "any" | "quorum"; quorum?: number };
type Failure = { mode: "collect" | "fail_fast" };

function makeSnapshot(join: Join = { mode: "all" }, failure: Failure = { mode: "collect" }, names = ["a", "b"]) {
  return initialSnapshot(
    "tg1",
    undefined,
    "fanout",
    join,
    failure,
    names.map((n) => ({ name: n, agent: "scout" })),
  );
}

function startedEvent(names: string[], join: Join, failure: Failure): GroupEvent {
  return {
    type: "group_started",
    groupId: "tg1",
    strategy: "fanout",
    join,
    failure,
    taskNames: names.map((n) => ({ name: n, agent: "scout" })),
    startedAtMs: Date.now(),
  };
}

describe("snapshot reducer", () => {
  test("folds task transitions and recomputes counts", () => {
    const r = new SnapshotReducer(makeSnapshot());
    r.apply(startedEvent(["a", "b"], { mode: "all" }, { mode: "collect" }));
    let s = r.current;
    expect(s.state).toBe("running");
    expect(s.counts).toMatchObject({ queued: 2, total: 2 });

    r.apply({ type: "task_state", name: "a", state: "running", handle: "agent://a" });
    s = r.current;
    expect(s.counts).toMatchObject({ queued: 1, running: 1 });
    expect(s.tasks[0]?.handle).toBe("agent://a");

    r.apply({ type: "task_state", name: "a", state: "succeeded", durationMs: 100 });
    r.apply({ type: "task_state", name: "b", state: "failed", error: "boom" });
    s = r.current;
    expect(s.counts).toMatchObject({ succeeded: 1, failed: 1 });
    expect(s.state).toBe("joining"); // all settled
  });

  test("any join flips to joining on first success", () => {
    const r = new SnapshotReducer(makeSnapshot({ mode: "any" }, { mode: "collect" }));
    r.apply(startedEvent(["a", "b"], { mode: "any" }, { mode: "collect" }));
    r.apply({ type: "task_state", name: "a", state: "succeeded" });
    expect(r.current.state).toBe("joining");
  });

  test("quorum join flips at threshold", () => {
    const r = new SnapshotReducer(makeSnapshot({ mode: "quorum", quorum: 2 }, { mode: "collect" }, ["a", "b", "c"]));
    r.apply(startedEvent(["a", "b", "c"], { mode: "quorum", quorum: 2 }, { mode: "collect" }));
    r.apply({ type: "task_state", name: "a", state: "succeeded" });
    expect(r.current.state).toBe("running");
    r.apply({ type: "task_state", name: "b", state: "succeeded" });
    expect(r.current.state).toBe("joining");
  });

  test("fail_fast flips on first failure", () => {
    const r = new SnapshotReducer(makeSnapshot({ mode: "all" }, { mode: "fail_fast" }));
    r.apply(startedEvent(["a", "b"], { mode: "all" }, { mode: "fail_fast" }));
    r.apply({ type: "task_state", name: "a", state: "failed" });
    expect(r.current.state).toBe("joining");
  });

  test("collect mode with failures stays running until all settle", () => {
    const r = new SnapshotReducer(makeSnapshot({ mode: "all" }, { mode: "collect" }));
    r.apply(startedEvent(["a", "b"], { mode: "all" }, { mode: "collect" }));
    r.apply({ type: "task_state", name: "a", state: "failed" });
    expect(r.current.state).toBe("running");
    r.apply({ type: "task_state", name: "b", state: "succeeded" });
    expect(r.current.state).toBe("joining");
  });

  test("finalize stamps duration and state", () => {
    const r = new SnapshotReducer(makeSnapshot({ mode: "all" }, { mode: "collect" }, ["a"]));
    r.apply(startedEvent(["a"], { mode: "all" }, { mode: "collect" }));
    r.apply({ type: "task_state", name: "a", state: "succeeded" });
    const s = r.finalize("completed", 1234);
    expect(s.state).toBe("completed");
    expect(s.durationMs).toBe(1234);
    expect(s.protocol).toBe("omp-task-group/v1");
  });

  test("unknown task names are ignored (defensive)", () => {
    const r = new SnapshotReducer(makeSnapshot({ mode: "all" }, { mode: "collect" }, ["a"]));
    r.apply(startedEvent(["a"], { mode: "all" }, { mode: "collect" }));
    r.apply({ type: "task_state", name: "ghost", state: "failed" });
    expect(r.current.counts.queued).toBe(1);
    expect(r.current.counts.failed).toBe(0);
  });
});
