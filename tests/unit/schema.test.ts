import { describe, expect, test } from "bun:test";
import { isBackgroundRequested, validateSpec, SpecValidationError } from "../../src/schema/task-group";

const BASE = {
  context: "Shared research context.",
  tasks: [
    { name: "alpha", agent: "scout", task: "Do A." },
    { name: "beta", agent: "scout", task: "Do B." },
  ],
};

describe("validateSpec", () => {
  test("accepts a minimal valid spec with defaults", () => {
    const spec = validateSpec(BASE);
    expect(spec.join.mode).toBe("all");
    expect(spec.failure.mode).toBe("collect");
    expect(spec.execution.strategy).toBe("auto");
    expect(spec.execution.concurrency).toBe("auto");
    expect(spec.execution.mode).toBe("auto");
    expect(spec.background).toBe("auto");
    expect(spec.output.mode).toBe("compact");
    expect(spec.output.perTaskChars).toBe(1200);
    expect(spec.output.maxTotalChars).toBe(8000);
    expect(spec.output.preserveHandles).toBe(true);
    expect(spec.tasks[1]?.agent).toBe("scout");
  });

  test("accepts explicit background opt-in and keeps auto/foreground foreground", () => {
    expect(validateSpec({ ...BASE, background: "foreground" }).background).toBe("foreground");
    expect(validateSpec({ ...BASE, background: "auto" }).background).toBe("auto");
    const require = validateSpec({ ...BASE, background: "require" });
    expect(require.background).toBe("require");
    expect(isBackgroundRequested(require)).toBe(true);
    expect(isBackgroundRequested(validateSpec(BASE))).toBe(false);
    expect(isBackgroundRequested(validateSpec({ ...BASE, background: "foreground" }))).toBe(false);
    expect(() => validateSpec({ ...BASE, background: "always" })).toThrow(/must be "auto" \| "foreground" \| "require"/);
    expect(() => validateSpec({ ...BASE, background: true })).toThrow(/must be "auto"/);
  });

  test("accepts execution.mode=background and rejects contradictory explicit policies", () => {
    const spec = validateSpec({ ...BASE, execution: { mode: "background" } });
    expect(spec.execution.mode).toBe("background");
    expect(isBackgroundRequested(spec)).toBe(true);
    expect(validateSpec({ ...BASE, execution: { mode: "auto" } }).execution.mode).toBe("auto");
    expect(validateSpec({ ...BASE, execution: { mode: "foreground" } }).execution.mode).toBe("foreground");
    expect(() =>
      validateSpec({ ...BASE, background: "require", execution: { mode: "foreground" } }),
    ).toThrow(/background="require" conflicts with execution.mode="foreground"/);
    expect(() =>
      validateSpec({ ...BASE, background: "foreground", execution: { mode: "background" } }),
    ).toThrow(/background="foreground" conflicts with execution.mode="background"/);
    expect(() => validateSpec({ ...BASE, execution: { mode: "always" } })).toThrow(
      /must be "auto" \| "foreground" \| "background"/,
    );
    expect(() => validateSpec({ ...BASE, execution: { mode: true } })).toThrow(/must be "auto"/);
  });

  test("rejects fewer than 2 tasks", () => {
    expect(() => validateSpec({ context: "x", tasks: [{ name: "a", task: "t" }] })).toThrow(SpecValidationError);
  });

  test("rejects duplicate names", () => {
    expect(() =>
      validateSpec({
        context: "x",
        tasks: [
          { name: "same", task: "a" },
          { name: "same", task: "b" },
        ],
      }),
    ).toThrow(/duplicate name/);
  });

  test("rejects invalid names", () => {
    expect(() =>
      validateSpec({
        context: "x",
        tasks: [
          { name: "Bad Name!", task: "a" },
          { name: "ok", task: "b" },
        ],
      }),
    ).toThrow(/name must match/);
  });

  test("quorum requires quorum field within task count", () => {
    expect(() => validateSpec({ ...BASE, join: { mode: "quorum" } })).toThrow(/quorum is required/);
    expect(() => validateSpec({ ...BASE, join: { mode: "quorum", quorum: 5 } })).toThrow(/integer in \[1, 2\]/);
    const ok = validateSpec({ ...BASE, join: { mode: "quorum", quorum: 1 } });
    expect(ok.join.quorum).toBe(1);
  });

  test("quorum rejected outside quorum mode", () => {
    expect(() => validateSpec({ ...BASE, join: { mode: "all", quorum: 1 } })).toThrow(/only valid/);
  });

  test("rejects unknown enums", () => {
    expect(() => validateSpec({ ...BASE, join: { mode: "majority" } })).toThrow(/join.mode/);
    expect(() => validateSpec({ ...BASE, failure: { mode: "ignore" } })).toThrow(/failure.mode/);
    expect(() => validateSpec({ ...BASE, execution: { strategy: "dag" } })).toThrow(/execution.strategy/);
    expect(() => validateSpec({ ...BASE, execution: { strategy: "auto", concurrency: 99 } })).toThrow(/concurrency/);
    expect(() => validateSpec({ ...BASE, output: { mode: "raw" } })).toThrow(/output.mode/);
  });

  test("maxTotalChars must cover perTaskChars", () => {
    expect(() =>
      validateSpec({ ...BASE, output: { mode: "compact", perTaskChars: 5000, maxTotalChars: 1000 } }),
    ).toThrow(/maxTotalChars/);
  });

  test("empty context rejected", () => {
    expect(() => validateSpec({ ...BASE, context: "   " })).toThrow(/context is required/);
  });
});
