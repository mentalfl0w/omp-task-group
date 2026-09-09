import { describe, expect, test } from "bun:test";
import {
  ENVELOPE_NAME,
  parseTaskGroupEnvelope,
  type EnvelopeErrorCode,
  type EnvelopeParseError,
} from "../../src/envelope";

// ── Fixtures ───────────────────────────────────────────────────────────

const SPEC = {
  context: "Shared context for every child.",
  label: "probe",
  tasks: [
    { name: "alpha", agent: "scout", task: "Scan the repo." },
    { name: "beta", agent: "task", task: "Scan the docs.", effort: "lo" },
  ],
  join: { mode: "quorum", quorum: 2 },
  failure: { mode: "collect" },
  execution: { strategy: "fanout", concurrency: 2 },
  output: { mode: "structured", perTaskChars: 2000, maxTotalChars: 6000, preserveHandles: true },
  pool: { enabled: "auto", threshold: 6, fallback: "fanout" },
};

const PRETTY = `ompTaskGroup({
  "context": "Ctx.",
  "tasks": [
    { "name": "alpha", "agent": "scout", "task": "Scan the repo." },
    { "name": "beta", "agent": "task", "task": "Scan the docs." }
  ],
  "join": { "mode": "all" },
  "failure": { "mode": "collect" },
  "execution": { "strategy": "auto", "concurrency": "auto" },
  "output": { "mode": "compact", "perTaskChars": 1200, "maxTotalChars": 8000, "preserveHandles": true },
  "pool": { "enabled": "auto", "threshold": 6, "fallback": "fanout" }
});`;

const OPEN_PAREN: string[] = [
  "ompTaskGroup",
  "ompTaskGroup;",
  'ompTaskGroup ({"a":1})',
  'ompTaskGroup\n({"a":1})',
  "ompTaskGroup\t()",
  "ompTaskGroup.spec({})",
  "ompTaskGroup = 1;",
  "ompTaskGroup/**/({})",
];

const UNTERMINATED: string[] = [
  "ompTaskGroup(",
  'ompTaskGroup({"a":1}',
  'ompTaskGroup({"a":")"}',
  'ompTaskGroup(({"a":1})',
  'ompTaskGroup( {"a":1}  ',
];

const MISSING_ARG: string[] = ["ompTaskGroup()", "ompTaskGroup( )", "ompTaskGroup(\n\t )"];

const MULTIPLE_ARGS: string[] = [
  "ompTaskGroup({}, {})",
  'ompTaskGroup("a", "b")',
  "ompTaskGroup(1, 2)",
  'ompTaskGroup({"a":1},\n{"b":2})',
];

const INVALID_JSON: string[] = [
  "ompTaskGroup({invalid})",
  "ompTaskGroup({'a':1})",
  "ompTaskGroup({a:1})",
  'ompTaskGroup({"a":1,})',
  "ompTaskGroup(undefined)",
  "ompTaskGroup(NaN)",
  "ompTaskGroup(1 2)",
  "ompTaskGroup(+1)",
];

const TRAILING: string[] = [
  "ompTaskGroup({}) extra",
  "ompTaskGroup({}); console.log(1)",
  "ompTaskGroup({});;",
  "ompTaskGroup({}); ;",
  "ompTaskGroup({}); // note",
  "ompTaskGroup({}))",
  "ompTaskGroup({}) ompTaskGroup({})",
  "ompTaskGroup({});return 1",
];

// ── Helpers (narrow a parse result or fail the test with the full result) ─

function expectValid(code: unknown): { spec: unknown; rawJson: string } {
  const result = parseTaskGroupEnvelope(code);
  if (result.kind !== "valid") {
    throw new Error(`expected a valid envelope, got: ${JSON.stringify(result)}`);
  }
  return { spec: result.spec, rawJson: result.rawJson };
}

function expectMalformed(code: string, expectedCode?: EnvelopeErrorCode): EnvelopeParseError {
  const result = parseTaskGroupEnvelope(code);
  if (result.kind !== "malformed") {
    throw new Error(`expected a malformed envelope, got: ${JSON.stringify(result)}`);
  }
  expect(result.error.message.length).toBeGreaterThan(0);
  if (expectedCode !== undefined) expect(result.error.code).toBe(expectedCode);
  return result.error;
}

function expectNonEnvelope(code: unknown): void {
  const result = parseTaskGroupEnvelope(code);
  if (result.kind !== "non-envelope") {
    throw new Error(`expected a non-envelope, got: ${JSON.stringify(result)}`);
  }
}

// ── Valid envelopes ────────────────────────────────────────────────────

describe("envelope parser — valid envelopes", () => {
  test("parses a well-formed object envelope and returns the raw spec", () => {
    const { spec, rawJson } = expectValid(`ompTaskGroup(${JSON.stringify(SPEC)})`);
    expect(spec).toEqual(SPEC);
    expect(rawJson).toBe(JSON.stringify(SPEC));
  });

  test("allows outer whitespace around the envelope", () => {
    const code = `ompTaskGroup(${JSON.stringify(SPEC)})`;
    for (const wrapped of [`  ${code}`, `\n\t ${code}  \r\n`, `\u00A0${code}`]) {
      expect(expectValid(wrapped).spec).toEqual(SPEC);
    }
  });

  test("allows at most one terminal semicolon after the envelope", () => {
    const code = `ompTaskGroup(${JSON.stringify(SPEC)})`;
    for (const suffix of [";", " ;", "\n;", ";\n  "]) {
      const result = expectValid(code + suffix);
      expect(result.spec).toEqual(SPEC);
    }
  });

  test("accepts pretty-printed multi-line JSON arguments", () => {
    const { spec, rawJson } = expectValid(PRETTY);
    expect(spec).toMatchObject({ context: "Ctx." });
    expect((spec as { tasks: unknown[] }).tasks).toHaveLength(2);
    expect(rawJson).toContain("\n  \"context\"");
  });

  test("keeps parentheses, braces, and brackets inside JSON strings inert", () => {
    const cases: Array<[string, Record<string, string>]> = [
      ['ompTaskGroup({"prompt":"call f(1) {x} [y] then )"})', { prompt: "call f(1) {x} [y] then )" }],
      ['ompTaskGroup({"a":")","b":"(","c":"{","d":"}"})', { a: ")", b: "(", c: "{", d: "}" }],
      ['ompTaskGroup({"a":"(unbalanced","b":"balanced)"})', { a: "(unbalanced", b: "balanced)" }],
    ];
    for (const [code, expected] of cases) {
      expect(expectValid(code).spec).toEqual(expected);
    }
  });

  test("treats escaped quotes and backslashes inside strings correctly", () => {
    const escapedQuote = expectValid('ompTaskGroup({"prompt":"say \\"hi\\" and )"})');
    expect(escapedQuote.spec).toEqual({ prompt: 'say "hi" and )' });

    // "\\" inside the JSON string is an escaped backslash, not the string terminator.
    const escapedBackslash = expectValid('ompTaskGroup({"a":"\\\\"})');
    expect(escapedBackslash.spec).toEqual({ a: "\\" });

    const twoBackslashes = expectValid('ompTaskGroup({"p":"a\\\\b"})');
    expect(twoBackslashes.spec).toEqual({ p: "a\\b" });
  });

  test("handles a ) character inside a string immediately before the closer", () => {
    expect(expectValid('ompTaskGroup({"pattern":")"})').spec).toEqual({ pattern: ")" });
    expect(expectValid('ompTaskGroup({"x":{"y":")"}} )').spec).toEqual({ x: { y: ")" } });
  });

  test("decodes \\u escapes that spell ) or } without derailing the scan", () => {
    const result = expectValid('ompTaskGroup({"sep":"\\u0029","open":"\\u007b","close":"\\u007d"})');
    expect(result.spec).toEqual({ sep: ")", open: "{", close: "}" });
  });

  test("preserves the raw argument text verbatim", () => {
    expect(expectValid('ompTaskGroup(  {"a":1}  )').rawJson).toBe('  {"a":1}  ');
  });

  test("accepts any strict JSON value at the parse level (raw spec, no schema check)", () => {
    const scalarCases: Array<[string, unknown]> = [
      ["ompTaskGroup(42)", 42],
      ["ompTaskGroup(1.5e3)", 1500],
      ['ompTaskGroup("hi")', "hi"],
      ["ompTaskGroup(true)", true],
      ["ompTaskGroup(false)", false],
      ["ompTaskGroup(null)", null],
      ["ompTaskGroup([1,2,3])", [1, 2, 3]],
      ["ompTaskGroup([])", []],
      ["ompTaskGroup({})", {}],
    ];
    for (const [code, expected] of scalarCases) {
      expect(expectValid(code).spec).toEqual(expected);
    }
  });

  test("accepts a UTF-8 BOM before the envelope", () => {
    expect(expectValid(`\uFEFFompTaskGroup(${JSON.stringify(SPEC)})`).spec).toEqual(SPEC);
  });
});

// ── Non-envelopes ──────────────────────────────────────────────────────

describe("envelope parser — non-envelopes", () => {
  test("empty and whitespace-only code is non-envelope", () => {
    for (const code of ["", "   ", "\n\t  \r\n"]) expectNonEnvelope(code);
  });

  test("plain JavaScript cells are non-envelope", () => {
    const js = [
      "console.log('hi')",
      "const x = 1; x + 1",
      "await agent('do the thing')",
      "1 + 1",
      "return 42",
      "// ompTaskGroup({})\nconsole.log(1)",
      "/* ompTaskGroup({}) */ 1",
      "await ompTaskGroup({})", // envelope must BE the code, not an expression within it
    ];
    for (const code of js) expectNonEnvelope(code);
  });

  test("code that merely mentions the name mid-program is non-envelope", () => {
    const js = [
      "const f = () => ompTaskGroup({}); f()",
      "foo(ompTaskGroup({}))",
      "const y = 1; ompTaskGroup({})",
      "Promise.resolve(ompTaskGroup)",
    ];
    for (const code of js) expectNonEnvelope(code);
  });

  test("identifiers that merely extend or vary the reserved name are non-envelope", () => {
    const js = [
      "ompTaskGroupish({})",
      "ompTaskGroupX({})",
      "ompTaskGroup2(1)",
      "ompTaskGroup_foo({})",
      "ompTaskGroup$({})",
      "omptaskgroup({})",
      "OmpTaskGroup({})",
      "ompTaskGrouP({})",
    ];
    for (const code of js) expectNonEnvelope(code);
  });

  test("non-string code is never an envelope and never throws", () => {
    const inputs: unknown[] = [null, undefined, 42, 42n, true, {}, [], Symbol("x"), () => 0];
    for (const input of inputs) {
      expect(() => parseTaskGroupEnvelope(input)).not.toThrow();
      expectNonEnvelope(input);
    }
  });

  test("exposes the reserved entry-point name as a public constant", () => {
    expect(ENVELOPE_NAME).toBe("ompTaskGroup");
  });
});

// ── Recognized malformed envelopes ─────────────────────────────────────

describe("envelope parser — recognized malformed envelopes", () => {
  test("bare or mis-punctuated entry points are malformed (expected-open-paren)", () => {
    for (const code of OPEN_PAREN) expectMalformed(code, "expected-open-paren");
    const error = expectMalformed("ompTaskGroup");
    expect(error.message).toContain('"("');
    expect(error.message).toContain("ompTaskGroup");
  });

  test("an envelope that never closes is malformed (unterminated)", () => {
    for (const code of UNTERMINATED) expectMalformed(code, "unterminated");
    expect(expectMalformed('ompTaskGroup({"a":")"}').message).toContain('")"');
  });

  test("an empty argument is malformed (missing-argument)", () => {
    for (const code of MISSING_ARG) expectMalformed(code, "missing-argument");
  });

  test("more than one argument is malformed (multiple-arguments)", () => {
    for (const code of MULTIPLE_ARGS) expectMalformed(code, "multiple-arguments");
  });

  test("non-JSON arguments are malformed (invalid-json)", () => {
    for (const code of INVALID_JSON) expectMalformed(code, "invalid-json");
    const error = expectMalformed("ompTaskGroup({invalid})");
    expect(error.message).toContain("not strict JSON");
    expect(error.detail?.length ?? 0).toBeGreaterThan(0);
  });

  test("a raw newline inside a JSON string is invalid JSON, not accepted", () => {
    const code = 'ompTaskGroup({"a":"x' + "\n" + 'y"})';
    expectMalformed(code, "invalid-json");
  });

  test("trailing code after the envelope is malformed (trailing-content)", () => {
    for (const code of TRAILING) expectMalformed(code, "trailing-content");
    expect(expectMalformed("ompTaskGroup({}) extra").message).toContain('";"');
  });

  test("never evaluates the argument or trailing code — parse is JSON.parse only", () => {
    // If any of these were executed the test process would exit(>0) and the
    // suite would die. Their survival is the proof that nothing runs.
    expectMalformed("ompTaskGroup(process.exit(9))", "invalid-json");
    expectMalformed("ompTaskGroup({}); process.exit(7)", "trailing-content");
    expectMalformed("ompTaskGroup((() => { process.exit(7) })())", "invalid-json");
    expectMalformed("ompTaskGroup(() => process.exit(9))", "invalid-json");
  });

  test("parsing pathological inputs never throws — a result is always returned", () => {
    const nasty = [
      ...OPEN_PAREN,
      ...UNTERMINATED,
      ...MISSING_ARG,
      ...MULTIPLE_ARGS,
      ...INVALID_JSON,
      ...TRAILING,
      'ompTaskGroup({"a":"\\',
      "ompTaskGroup(" + '"'.repeat(50),
      "ompTaskGroup()".repeat(20),
    ];
    for (const code of nasty) {
      expect(() => parseTaskGroupEnvelope(code)).not.toThrow();
      const kind = parseTaskGroupEnvelope(code).kind;
      expect(["non-envelope", "malformed", "valid"]).toContain(kind);
    }
  });

  test("every documented error code is reachable (stable taxonomy)", () => {
    const seen = new Set<string>();
    for (const code of OPEN_PAREN) seen.add(expectMalformed(code, "expected-open-paren").code);
    for (const code of UNTERMINATED) seen.add(expectMalformed(code, "unterminated").code);
    for (const code of MISSING_ARG) seen.add(expectMalformed(code, "missing-argument").code);
    for (const code of MULTIPLE_ARGS) seen.add(expectMalformed(code, "multiple-arguments").code);
    for (const code of INVALID_JSON) seen.add(expectMalformed(code, "invalid-json").code);
    for (const code of TRAILING) seen.add(expectMalformed(code, "trailing-content").code);
    expect(seen.size).toBe(6);
  });
});

// ── Discrimination semantics ───────────────────────────────────────────

describe("envelope parser — discrimination semantics", () => {
  test("distinguishes non-envelope from recognized-malformed from valid", () => {
    expectNonEnvelope("console.log(1)");
    expectNonEnvelope("ompTaskGroupish({})");
    expectNonEnvelope("const ompTaskGroup = 1;");
    expectMalformed("ompTaskGroup ({})", "expected-open-paren");
    expectMalformed("ompTaskGroup({broken})", "invalid-json");
    expectMalformed("ompTaskGroup()", "missing-argument");
    expectValid("ompTaskGroup({})");
  });

  test("a valid envelope result is not schema-validated by the parser", () => {
    // Envelope grammar + strict JSON only; TaskGroupSpec validation happens
    // downstream in schema/task-group before compilation.
    expectValid('ompTaskGroup({"context":""})');
    expectValid('ompTaskGroup({"tasks":[]})');
    expect(expectValid("ompTaskGroup({})").spec).toEqual({});
  });
});
