import { describe, expect, test } from "bun:test";
import { decodeDisplayGroupResult, DisplayResultError } from "../../src/backend/display-result";
import type { GroupRunResult, TaskOutcome } from "../../src/backend/interface";
import { DISPLAY_PROTOCOL } from "../../src/compiler/program";
import { validateSpec } from "../../src/schema/task-group";

const SPEC = validateSpec({
  context: "Shared.",
  tasks: [
    { name: "alpha", agent: "scout", task: "A" },
    { name: "beta", agent: "scout", task: "B" },
  ],
});

const GID = "tg-abc";

type Wire = Record<string, unknown>;

function outcome(name: string, over: Wire = {}): Wire {
  return { name, agent: "scout", status: "succeeded", ...over };
}

function both(alpha: Wire, beta: Wire): Wire[] {
  return [outcome("alpha", alpha), outcome("beta", beta)];
}

function makePayload(over: Wire = {}): Wire {
  return {
    protocol: DISPLAY_PROTOCOL,
    groupId: GID,
    strategy: "fanout",
    groupState: "completed",
    rawChildChars: 128,
    outcomes: both({ result: "A" }, { result: "B" }),
    ...over,
  };
}

function details(entries: unknown[], extra: Wire = {}): Wire {
  return { jsonOutputs: entries, ...extra };
}

function decodeResult(d: unknown = details([makePayload()])): GroupRunResult {
  return decodeDisplayGroupResult(d, SPEC, GID);
}

function outcomeOf(result: GroupRunResult, name: string): TaskOutcome | undefined {
  return result.outcomes.find((o) => o.name === name);
}

describe("payload selection", () => {
  test("decodes a completed fanout payload into a GroupRunResult", () => {
    const r = decodeResult();
    expect(r.groupId).toBe(GID);
    expect(r.strategy).toBe("fanout");
    expect(r.rawChildChars).toBe(128);
    expect(r.groupError).toBeUndefined();
    expect(r.summary).toBeUndefined();
    expect(r.cancelled).toBeUndefined();
    expect(r.barrierViolated).toBeUndefined();
    expect(r.outcomes.map((o) => o.name).sort()).toEqual(["alpha", "beta"]);
    expect(outcomeOf(r, "alpha")).toMatchObject({ agent: "scout", status: "succeeded", result: "A" });
    expect(outcomeOf(r, "beta")).toMatchObject({ status: "succeeded", result: "B" });
  });

  test("decodes a pool payload with pool strategy", () => {
    const r = decodeResult(details([makePayload({ strategy: "pool" })]));
    expect(r.strategy).toBe("pool");
  });

  test("tolerates foreign display values and picks the exact protocol+groupId match", () => {
    const valid = makePayload();
    const r = decodeResult(
      details(["stray text", { protocol: "probe/v1", items: [1] }, { protocol: DISPLAY_PROTOCOL, groupId: "tg-other" }, valid]),
    );
    expect(r.groupId).toBe(GID);
    expect(outcomeOf(r, "alpha")).toBeDefined();
  });

  test("selects the matching entry wherever it appears", () => {
    const valid = makePayload({ rawChildChars: 999 });
    const r = decodeResult(details([valid, { protocol: DISPLAY_PROTOCOL, groupId: "tg-other" }]));
    expect(r.rawChildChars).toBe(999);
  });

  test("rejects duplicate protocol payloads for the same group", () => {
    const d = details([makePayload(), makePayload({ rawChildChars: 999 })]);
    expect(() => decodeResult(d)).toThrow(
      /found 2 omp-task-group\/eval-result-v1 display payloads for group "tg-abc" \(expected exactly one\)/,
    );
  });

  test("throws when no protocol payload exists among foreign entries", () => {
    const d = details([{ protocol: "other/v1", groupId: GID }, { protocol: DISPLAY_PROTOCOL, groupId: "tg-z" }]);
    expect(() => decodeResult(d)).toThrow(DisplayResultError);
  });

  test("empty jsonOutputs throws with a precise message", () => {
    expect(() => decodeResult(details([]))).toThrow(/no omp-task-group\/eval-result-v1 display payload for group "tg-abc"/);
  });

  test("foreign-only entries name the protocols seen", () => {
    const d = details([{ protocol: "probe/v1" }, 42]);
    expect(() => decodeResult(d)).toThrow(/display protocols seen: probe\/v1/);
  });

  test("wrong-group payload throws naming found group ids", () => {
    const d = details([makePayload({ groupId: "tg-other" })]);
    expect(() => decodeResult(d)).toThrow(/found 1 omp-task-group\/eval-result-v1 display payload\(s\) but none for group "tg-abc"/);
    expect(() => decodeResult(d)).toThrow(/group ids seen: tg-other/);
  });
});

describe("malformed details", () => {
  test("details must be an object", () => {
    for (const d of [null, "x", 42, []]) {
      expect(() => decodeResult(d)).toThrow(/details are not an object/);
    }
    expect(() => decodeDisplayGroupResult(undefined, SPEC, GID)).toThrow(/details are not an object/);
  });
  test("jsonOutputs must be an array", () => {
    for (const d of [details([], { jsonOutputs: undefined }), { jsonOutputs: "nope" }, { jsonOutputs: {} }]) {
      expect(() => decodeResult(d)).toThrow(/jsonOutputs is missing or not an array/);
    }
  });

  test("truthy details.async is a barrier violation and beats payload presence", () => {
    const withPayload = details([makePayload()], { async: { state: "running", jobId: "bg_1", type: "eval" } });
    expect(() => decodeResult(withPayload)).toThrow(/eval cell auto-backgrounded/);
    expect(() => decodeResult(withPayload)).toThrow(DisplayResultError);
    // async is checked before payload selection — an empty jsonOutputs still
    // reports the barrier, never a misleading "no payload" error.
    expect(() => decodeResult(details([], { async: true }))).toThrow(/auto-backgrounded/);
  });

  test("falsey details.async is not a barrier signal", () => {
    for (const async of [false, 0, null, ""]) {
      const r = decodeResult(details([makePayload()], { async }));
      expect(r.groupId).toBe(GID);
    }
  });

  test("all decode failures are DisplayResultError instances", () => {
    const cases: unknown[] = [
      null,
      details([]),
      details([{ protocol: "x" }]),
      details([makePayload({ strategy: "banana" })]),
      details([makePayload({ outcomes: [] })]),
    ];
    for (const d of cases) {
      try {
        decodeResult(d);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(DisplayResultError);
        expect((e as Error).name).toBe("DisplayResultError");
      }
    }
  });
});

describe("structural validation", () => {
  test("strategy must be fanout | pool", () => {
    for (const strategy of ["banana", 1, undefined]) {
      expect(() => decodeResult(details([makePayload({ strategy })]))).toThrow(/strategy must be "fanout" \| "pool"/);
    }
  });

  test("groupState must be a known state", () => {
    for (const groupState of ["running", "exploded", 7, undefined]) {
      expect(() => decodeResult(details([makePayload({ groupState })]))).toThrow(
        /groupState must be "completed" \| "failed" \| "cancelled"/,
      );
    }
  });

  test("rawChildChars must be a non-negative integer", () => {
    for (const rawChildChars of ["128", -1, 1.5, NaN, undefined]) {
      expect(() => decodeResult(details([makePayload({ rawChildChars })]))).toThrow(
        /rawChildChars must be a non-negative integer/,
      );
    }
  });

  test("outcomes must be a non-empty array", () => {
    for (const outcomes of ["nope", {}, [], undefined]) {
      expect(() => decodeResult(details([makePayload({ outcomes })]))).toThrow(
        /outcomes must be a non-empty array/,
      );
    }
  });
});

describe("outcome integrity", () => {
  test("unknown task names are rejected", () => {
    const outcomes = [outcome("alpha", { result: "A" }), outcome("ghost", { result: "B" })];
    expect(() => decodeResult(details([makePayload({ outcomes })]))).toThrow(
      /names unknown task "ghost" \(expected one of: alpha, beta\)/,
    );
  });

  test("missing task outcome is refused, never partial", () => {
    const outcomes = [outcome("alpha", { result: "A" })];
    expect(() => decodeResult(details([makePayload({ outcomes })]))).toThrow(
      /missing an outcome for task "beta" \(refusing partial success\)/,
    );
  });

  test("duplicate task outcome is rejected", () => {
    const outcomes = [outcome("alpha", { result: "A" }), outcome("alpha", { result: "dup" }), outcome("beta")];
    expect(() => decodeResult(details([makePayload({ outcomes })]))).toThrow(
      /2 outcomes for task "alpha" \(expected exactly one\)/,
    );
  });

  test("unknown statuses are rejected", () => {
    const outcomes = both({ status: "exploded" }, {});
    expect(() => decodeResult(details([makePayload({ outcomes })]))).toThrow(
      /has unknown status "exploded" \(expected "succeeded" \| "failed" \| "cancelled"\)/,
    );
  });

  test("non-object outcome entries are rejected", () => {
    const outcomes = [42, outcome("beta")];
    expect(() => decodeResult(details([makePayload({ outcomes })]))).toThrow(/outcomes\[0\] must be an object/);
  });

  test("empty or non-string name is rejected", () => {
    for (const name of ["", 7, undefined]) {
      const outcomes = [outcome("alpha", { name })];
      expect(() => decodeResult(details([makePayload({ outcomes })]))).toThrow(/outcomes\[0\]\.name must be a non-empty string/);
    }
  });

  test("empty or non-string agent is rejected", () => {
    for (const agent of ["", 7, undefined]) {
      const outcomes = [outcome("alpha", { agent })];
      expect(() => decodeResult(details([makePayload({ outcomes })]))).toThrow(/\(alpha\)\.agent must be a non-empty string/);
    }
  });

  test("agent identity must match the requested task", () => {
    const outcomes = both({ agent: "reviewer" }, {});
    expect(() => decodeResult(details([makePayload({ outcomes })]))).toThrow(
      /\(alpha\)\.agent must equal the requested task agent "scout"/,
    );
  });

  test("mistyped optional outcome fields are rejected", () => {
    const cases: Array<{ key: string; value: unknown; pattern: RegExp }> = [
      { key: "handle", value: 7, pattern: /\.handle must be a string/ },
      { key: "durationMs", value: "4", pattern: /\.durationMs must be a non-negative number/ },
      { key: "durationMs", value: -1, pattern: /\.durationMs must be a non-negative number/ },
      { key: "resolvedModel", value: {}, pattern: /\.resolvedModel must be a string/ },
      { key: "result", value: { x: 1 }, pattern: /\.result must be a string/ },
      { key: "error", value: 42, pattern: /\.error must be a string/ },
    ];
    for (const c of cases) {
      const outcomes = both({ [c.key]: c.value }, {});
      expect(() => decodeResult(details([makePayload({ outcomes })]))).toThrow(c.pattern);
    }
  });
});

describe("optional content preservation", () => {
  test("succeeded outcomes keep handle, durationMs, resolvedModel and result", () => {
    const r = decodeResult(
      details([
        makePayload({
          outcomes: both(
            { result: "alpha out", handle: "agent://tg-abc-alpha", durationMs: 4123, resolvedModel: "deepseek-v4" },
            { result: "beta out" },
          ),
        }),
      ]),
    );
    expect(outcomeOf(r, "alpha")).toMatchObject({
      status: "succeeded",
      result: "alpha out",
      handle: "agent://tg-abc-alpha",
      durationMs: 4123,
      resolvedModel: "deepseek-v4",
    });
  });

  test("structured JSON outputs survive verbatim", () => {
    const structuredAlpha = { verdict: "ok", nested: { scores: [1, 2, 3] } };
    const structuredBeta = [true, "x", null];
    const r = decodeResult(
      details([makePayload({ outcomes: both({ structured: structuredAlpha }, { structured: structuredBeta }) })]),
    );
    expect(outcomeOf(r, "alpha")?.structured).toEqual(structuredAlpha);
    expect(outcomeOf(r, "beta")?.structured).toEqual(structuredBeta);
  });

  test("falsey structured values are real outputs and are preserved", () => {
    for (const structured of [null, 0, false, ""]) {
      const r = decodeResult(details([makePayload({ outcomes: both({ structured }, {}) })]));
      expect(outcomeOf(r, "alpha")?.structured).toBe(structured);
    }
  });

  test("bare success carries neither result nor structured", () => {
    const r = decodeResult(details([makePayload({ outcomes: both({}, {}) })]));
    const alpha = outcomeOf(r, "alpha");
    expect(alpha?.result).toBeUndefined();
    expect("structured" in (alpha ?? {})).toBe(false);
  });

  test("failed and cancelled outcomes keep their error text", () => {
    const r = decodeResult(
      details([
        makePayload({
          outcomes: both({ status: "cancelled", error: "reaped after quorum", durationMs: 20 }, { status: "failed", error: "child exploded" }),
        }),
      ]),
    );
    expect(outcomeOf(r, "alpha")).toMatchObject({ status: "cancelled", error: "reaped after quorum", durationMs: 20 });
    expect(outcomeOf(r, "beta")).toMatchObject({ status: "failed", error: "child exploded" });
  });

  test("failure without error text is legal", () => {
    const r = decodeResult(details([makePayload({ outcomes: both({}, { status: "failed" }) })]));
    expect(outcomeOf(r, "beta")).toMatchObject({ status: "failed" });
    expect(outcomeOf(r, "beta")?.error).toBeUndefined();
  });
});

describe("groupError / summary / summaryError", () => {
  test("explicit groupError is preserved verbatim, not synthesized over", () => {
    const r = decodeResult(
      details([makePayload({ groupState: "failed", groupError: "group exceeded maxGroupMs guard" })]),
    );
    expect(r.groupError).toBe("group exceeded maxGroupMs guard");
    expect(r.groupError).not.toMatch(/task\(s\) failed/);
  });

  test("summary is preserved on a completed group", () => {
    const r = decodeResult(details([makePayload({ summary: "digest: both done" })]));
    expect(r.summary).toBe("digest: both done");
    expect(r.groupError).toBeUndefined();
  });

  test("summaryError folds into groupError when no group error is present", () => {
    const r = decodeResult(details([makePayload({ summaryError: "model timeout" })]));
    expect(r.groupError).toBe("summarizer failed: model timeout");
  });

  test("summaryError is not folded over an explicit groupError", () => {
    const r = decodeResult(details([makePayload({ groupError: "real failure", summaryError: "model timeout" })]));
    expect(r.groupError).toBe("real failure");
  });

  test("non-string groupError / summary / summaryError throw", () => {
    for (const key of ["groupError", "summary", "summaryError"] as const) {
      expect(() => decodeResult(details([makePayload({ [key]: 42 })]))).toThrow(
        new RegExp(`${key} must be a string`),
      );
    }
  });
});

describe("groupState mapping", () => {
  test("failed wire state without groupError synthesizes a descriptive one", () => {
    const r = decodeResult(
      details([
        makePayload({
          groupState: "failed",
          outcomes: both({ result: "A" }, { status: "failed", error: "child exploded" }),
        }),
      ]),
    );
    expect(r.cancelled).toBeUndefined();
    expect(r.groupError).toContain("group failed: 1/2 task(s) failed");
    expect(r.groupError).toContain("child exploded");
  });

  test("synthesis counts failed and cancelled outcomes", () => {
    const r = decodeResult(
      details([
        makePayload({
          groupState: "failed",
          outcomes: both({ status: "cancelled" }, { status: "failed", error: "boom" }),
        }),
      ]),
    );
    expect(r.groupError).toBe("group failed: 1/2 task(s) failed, 1 cancelled — boom");
  });

  test("synthesis covers an all-settled-but-failed inconsistency without guessing", () => {
    const r = decodeResult(
      details([
        makePayload({
          groupState: "failed",
          outcomes: both({ result: "A" }, { result: "B" }),
        }),
      ]),
    );
    expect(r.groupError).toMatch(/join condition unmet/);
  });

  test("cancelled wire state surfaces as cancelled:true", () => {
    const r = decodeResult(details([makePayload({ groupState: "cancelled" })]));
    expect(r.cancelled).toBe(true);
    expect(r.groupError).toBeUndefined();
  });

  test("completed and failed wire states never set cancelled", () => {
    for (const groupState of ["completed", "failed"]) {
      const r = decodeResult(details([makePayload({ groupState })]));
      expect(r.cancelled).toBeUndefined();
    }
  });
  test("decodes the structured JSON view returned by native OMP eval", () => {
    const payload = makePayload();
    const chunk = {
      protocol: DISPLAY_PROTOCOL,
      groupId: GID,
      transport: "omp-task-group/eval-result-view-v1",
      chunkIndex: 0,
      chunkCount: 1,
      data: JSON.stringify(payload),
    };
    const details = {
      cells: [{
        index: 0,
        output: "Task Group result view",
        views: [{ text: "Task Group result view", view: { kind: "json", value: chunk } }],
      }],
    };

    const result = decodeResult(details);

    expect(result.groupId).toBe(GID);
    expect(outcomeOf(result, "alpha")?.result).toBe("A");
    expect(outcomeOf(result, "beta")?.result).toBe("B");
  });

});
