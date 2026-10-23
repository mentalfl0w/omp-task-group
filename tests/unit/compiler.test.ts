import { describe, expect, test } from "bun:test";
import { compileFanoutProgram, compilePoolProgram, EVAL_RESULT_PROTOCOL } from "../../src/compiler/program";
import { validateSpec } from "../../src/schema/task-group";

const SPEC_RAW = {
  context: "Ctx.",
  label: "probe",
  tasks: [
    { name: "alpha", agent: "scout", task: "A" },
    { name: "beta", agent: "scout", task: "B" },
    { name: "gamma", agent: "scout", task: "C" },
  ],
  join: { mode: "quorum", quorum: 2 },
  failure: { mode: "collect" },
  execution: { strategy: "fanout", concurrency: 2 },
  output: { mode: "compact", perTaskChars: 500, maxTotalChars: 4000, preserveHandles: true },
};

function wrap(program: string): string {
  // Top-level await: wrap in an async fn. new Function throws on syntax errors.
  return `return async () => {\n${program}\n}`;
}

describe("compiler", () => {
  test("fanout program is syntactically valid JavaScript", () => {
    const spec = validateSpec(SPEC_RAW);
    const program = compileFanoutProgram(spec, { groupId: "tg-test" });
    new Function(wrap(program));
    expect(program.includes(EVAL_RESULT_PROTOCOL)).toBe(true);
  });

  test("pool program is syntactically valid JavaScript", () => {
    const spec = validateSpec({ ...SPEC_RAW, join: { mode: "all" } });
    const program = compilePoolProgram(spec, { groupId: "tg-test" });
    new Function(wrap(program));
  });


  test("EVAL_RESULT_PROTOCOL is the stable wire contract", () => {
    expect(EVAL_RESULT_PROTOCOL).toBe("omp-task-group/eval-result-v1");
  });

  test("spec embeds as double-encoded JSON and round-trips", () => {
    const spec = validateSpec(SPEC_RAW);
    const program = compileFanoutProgram(spec, { groupId: "tg-x" });
    const m = program.match(/const TG_SPEC = JSON\.parse\((".*?")\);/s);
    expect(m).not.toBeNull();
    const embedded = JSON.parse(JSON.parse(m![1] as string)) as typeof spec;
    expect(embedded.context).toBe(spec.context);
    expect(embedded.tasks.length).toBe(3);
    expect(embedded.join.mode).toBe("quorum");
  });

  test("join modes map to race-loop conditions", () => {
    const spec = validateSpec(SPEC_RAW);
    const program = compileFanoutProgram(spec, { groupId: "tg" });
    expect(program).toContain("tgSucceeded() >= q");
    const collect = validateSpec({ ...SPEC_RAW, join: { mode: "all" }, failure: { mode: "collect" } });
    const p2 = compileFanoutProgram(collect, { groupId: "tg" });
    expect(p2).toContain("await tgRaceLoop(() => false)");
    const failFast = validateSpec({ ...SPEC_RAW, join: { mode: "all" }, failure: { mode: "fail_fast" } });
    const p3 = compileFanoutProgram(failFast, { groupId: "tg" });
    expect(p3).toContain("tgFailed() > 0");
  });

  test("concurrency refills spawn slots after settles", () => {
    const spec = validateSpec(SPEC_RAW);
    const program = compileFanoutProgram(spec, { groupId: "tg" });
    expect(program).toMatch(/async function tgRaceLoop[\s\S]*?tgSpawnNext\(\);[\s\S]*?Promise\.race/);
  });
});
