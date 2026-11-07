import { describe, expect, test } from "bun:test";
import {
  compileFanoutProgram,
  compilePoolProgram,
  compilePoolBackgroundCollectProgram,
  compilePoolBackgroundDispatchProgram,
  EVAL_RESULT_PROTOCOL,
} from "../../src/compiler/program";
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
  test("generated eval programs do not call the removed hub tool", () => {
    const spec = validateSpec(SPEC_RAW);
    expect(compileFanoutProgram(spec, { groupId: "tg-no-hub" })).not.toContain("tool.hub(");
    expect(compilePoolProgram(spec, { groupId: "tg-no-hub" })).not.toContain("tool.hub(");
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

  test("background dispatch is valid JavaScript and never waits", () => {
    const spec = validateSpec({
      ...SPEC_RAW,
      join: { mode: "all" },
      failure: { mode: "collect" },
      execution: { strategy: "auto", concurrency: "auto" },
    });
    const program = compilePoolBackgroundDispatchProgram(spec, {
      groupId: "tg-bg",
      background: { resultId: "tgbg_0123456789abcdef" },
    });
    new Function(wrap(program));
    expect(program).toContain("TG_BG_REGISTRY_KEY");
    expect(program).toContain("workpool(");
    expect(program).toContain("pool.push(");
    expect(program).toContain("itemIds");
    expect(program).not.toContain("tool.wait(");
    expect(program).not.toContain("tgWaitForPool");
    expect(program).not.toContain("tgWriteBackgroundResult");
    expect(program).not.toContain("TG_BG_RESULT");
    // Success keeps the pool open; close/kill exist only on the failure path.
    expect(program).toContain("tgPoolCancel");
  });

  test("background collect is valid JavaScript and only peeks the retained pool", () => {
    const spec = validateSpec({
      ...SPEC_RAW,
      join: { mode: "all" },
      failure: { mode: "collect" },
      execution: { strategy: "auto", concurrency: "auto" },
    });
    const program = compilePoolBackgroundCollectProgram(spec, {
      groupId: "tg-bg",
      collect: {
        resultId: "tgbg_0123456789abcdef",
        path: "/tmp/omp-task-group-results-test/tg-bg.json",
        storeCapability: "a".repeat(64),
      },
    });
    new Function(wrap(program));
    expect(program).toContain("const TG_BG_RESULT = {");
    expect(program).toContain("tgStoreBackgroundResult");
    expect(program).toContain("tool.task_group_store_result");
    expect(program).toContain("tgGateCore");
    expect(program).toContain("TG_BG_REGISTRY_KEY");
    expect(program).toContain("pool.status()");
    expect(program).toContain("storeCapability");
    expect(program).toContain("pool.peek()");
    expect(program).not.toContain("writeFileSync");
    expect(program).not.toContain("openSync");
    expect(program).not.toContain("renameSync");
    expect(program).not.toContain("unlinkSync");
    expect(program).not.toContain("tgWriteBackgroundResult");
    expect(program).not.toContain("tool.wait(");
    expect(program).not.toContain("tool.read(");
    expect(program).not.toContain("tool.write(");
    expect(program).not.toContain("completion(");
    expect(program).not.toContain("tgMaybeSummarize");
    expect(program).not.toContain("tgWaitForPool");
  });

  test("foreground programs embed no background file transport or file writes", () => {
    const spec = validateSpec({ ...SPEC_RAW, join: { mode: "all" }, execution: { strategy: "auto", concurrency: "auto" } });
    for (const program of [
      compileFanoutProgram(spec, { groupId: "tg-fg" }),
      compilePoolProgram(spec, { groupId: "tg-fg" }),
    ]) {
      new Function(wrap(program));
      expect(program).not.toContain("TG_BG_RESULT");
      expect(program).not.toContain("TG_BG_FORMAT");
      expect(program).not.toContain("tgWriteBackgroundResult");
      expect(program).not.toContain("tgBgSha256");
      expect(program).not.toContain("writeFileSync");
      expect(program).not.toContain("openSync");
      expect(program).not.toContain("renameSync");
      expect(program).not.toContain("unlinkSync");
      // The background gate is computed in-cell only for collected results.
      expect(program).not.toContain("tgGateCore");
    }
  });
});
