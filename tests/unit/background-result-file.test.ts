import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  BACKGROUND_RESULT_FORMAT,
  BackgroundResultIntegrityError,
  parseBackgroundResultFile,
  sha256Hex,
} from "../../src/background/result-file";
import { EVAL_RESULT_PROTOCOL } from "../../src/compiler/program";

const GROUP = "tgabc123";
const RESULT = "tgbg_0123456789abcdef";

function payload(): Record<string, unknown> {
  return {
    protocol: EVAL_RESULT_PROTOCOL,
    groupId: GROUP,
    strategy: "fanout",
    groupState: "completed",
    rawChildChars: 4,
    outcomes: [
      { name: "alpha", agent: "sonic", status: "succeeded", result: "A" },
      { name: "beta", agent: "sonic", status: "succeeded", result: "B" },
    ],
  };
}

function wrapper(over: Record<string, unknown> = {}, payloadObject: unknown = payload()): string {
  const payloadJson = JSON.stringify(payloadObject);
  return JSON.stringify({
    format: BACKGROUND_RESULT_FORMAT,
    protocol: EVAL_RESULT_PROTOCOL,
    groupId: GROUP,
    resultId: RESULT,
    createdAtMs: 1_700_000_000_000,
    payloadChars: payloadJson.length,
    sha256: sha256Hex(payloadJson),
    payloadJson,
    ...over,
  });
}

describe("background result file verification", () => {
  test("accepts an untampered wrapper and returns the embedded payload", () => {
    const verified = parseBackgroundResultFile(wrapper(), { groupId: GROUP, resultId: RESULT });
    expect(verified.payload.protocol).toBe(EVAL_RESULT_PROTOCOL);
    expect(verified.payload.groupId).toBe(GROUP);
    expect(verified.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(verified.checksum).toBe(sha256Hex(verified.payloadJson));
    expect(verified.payloadChars).toBe(verified.payloadJson.length);
  });

  test("rejects a checksum mismatch", () => {
    expect(() =>
      parseBackgroundResultFile(wrapper({ sha256: "0".repeat(64) }), { groupId: GROUP, resultId: RESULT }),
    ).toThrow(BackgroundResultIntegrityError);
    expect(() =>
      parseBackgroundResultFile(wrapper({ sha256: "0".repeat(64) }), { groupId: GROUP, resultId: RESULT }),
    ).toThrow(/SHA-256 mismatch/);
  });

  test("rejects a mismatched group or result id", () => {
    expect(() => parseBackgroundResultFile(wrapper(), { groupId: "tgother", resultId: RESULT })).toThrow(
      /does not match the registered group/,
    );
    expect(() => parseBackgroundResultFile(wrapper(), { groupId: GROUP, resultId: "tgbg_ffffffffffffffff" })).toThrow(
      /does not match the registered result id/,
    );
  });

  test("rejects malformed wrappers and payloads", () => {
    expect(() => parseBackgroundResultFile("{", { groupId: GROUP, resultId: RESULT })).toThrow(/not valid JSON/);
    expect(() => parseBackgroundResultFile(wrapper({ format: "other" }), { groupId: GROUP, resultId: RESULT })).toThrow(
      /format must be/,
    );
    expect(() =>
      parseBackgroundResultFile(wrapper({ payloadChars: 1 }), { groupId: GROUP, resultId: RESULT }),
    ).toThrow(/payloadChars/);
    expect(() =>
      parseBackgroundResultFile(wrapper({}, null), { groupId: GROUP, resultId: RESULT }),
    ).toThrow(/payload must be an object/);
  });

  test("rejects an inner payload with a foreign group id or protocol", () => {
    const foreignGroup = { ...payload(), groupId: "tgbad" };
    expect(() =>
      parseBackgroundResultFile(wrapper({}, foreignGroup), { groupId: GROUP, resultId: RESULT }),
    ).toThrow(/payload groupId/);
    const foreignProtocol = { ...payload(), protocol: "other" };
    expect(() =>
      parseBackgroundResultFile(wrapper({}, foreignProtocol), { groupId: GROUP, resultId: RESULT }),
    ).toThrow(/payload protocol/);
  });

  test("sha256 is UTF-8 based, including CJK and emoji", () => {
    const value = "结果-😀-ещё";
    expect(sha256Hex(value)).toBe(createHash("sha256").update(value, "utf8").digest("hex"));
  });
});
