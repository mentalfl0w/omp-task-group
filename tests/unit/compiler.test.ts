import { describe, expect, test } from "bun:test";
import { compileFanoutProgram, compilePoolProgram, DISPLAY_PROTOCOL } from "../../src/compiler/program";
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
    expect(program.includes(DISPLAY_PROTOCOL)).toBe(true);
  });

  test("pool program is syntactically valid JavaScript", () => {
    const spec = validateSpec({ ...SPEC_RAW, join: { mode: "all" } });
    const program = compilePoolProgram(spec, { groupId: "tg-test" });
    new Function(wrap(program));
  });

  test("programs use ONLY public prelude helpers", () => {
    const spec = validateSpec({ ...SPEC_RAW, join: { mode: "all" } });
    const fanout = compileFanoutProgram(spec, { groupId: "tg" });
    const pool = compilePoolProgram(spec, { groupId: "tg" });
    for (const program of [fanout, pool]) {
      expect(program).not.toMatch(/import\s/);
      expect(program).not.toMatch(/require\(/);
      expect(program).not.toContain("@oh-my-pi");
      expect(program).not.toContain("process.");
      expect(program).toContain("display(");
      expect(program).toContain("phase(");
      expect(program).toContain("tool.hub(");
    }
    expect(fanout).toContain("agent(");
    expect(pool).toContain("workpool(");
  });

  test("display() is called exactly once per program", () => {
    const spec = validateSpec({ ...SPEC_RAW, join: { mode: "all" } });
    const fanout = compileFanoutProgram(spec, { groupId: "tg" });
    const pool = compilePoolProgram(spec, { groupId: "tg" });
    expect((fanout.match(/display\(/g) ?? []).length).toBe(1);
    expect((pool.match(/display\(/g) ?? []).length).toBe(1);
  });

  test("programs emit no @@TG_ marker transport", () => {
    const spec = validateSpec({ ...SPEC_RAW, join: { mode: "all" } });
    const fanout = compileFanoutProgram(spec, { groupId: "tg" });
    const pool = compilePoolProgram(spec, { groupId: "tg" });
    for (const program of [fanout, pool]) {
      expect(program).not.toMatch(/@@TG_/);
      expect(program).not.toMatch(/TG_EVENT|TG_FINAL|TG_FPART/);
    }
  });

  test("DISPLAY_PROTOCOL is the shared eval-result contract", () => {
    expect(DISPLAY_PROTOCOL).toBe("omp-task-group/eval-result-v1");
    const spec = validateSpec(SPEC_RAW);
    const program = compileFanoutProgram(spec, { groupId: "tg-x" });
    expect(program).toContain(`const TG_PROTOCOL = ${JSON.stringify(DISPLAY_PROTOCOL)};`);
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
