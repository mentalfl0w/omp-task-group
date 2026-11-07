/**
 * omp-task-group — background result file format and integrity checks.
 *
 * The two-phase Workpool collect cell writes one wrapper object atomically
 * into the session-private result directory. The wrapper embeds the exact
 * payload JSON string so the checksum is computed over an immutable byte
 * representation instead of a re-serialized object (key order and Unicode stay
 * stable).
 *
 * Host-side reads re-verify the format, group/result identity, payload size,
 * and SHA-256 before the payload reaches the normal eval decoder and Result
 * Gate. A tampered or truncated file is an explicit integrity error, never a
 * partial success.
 */

import { createHash } from "node:crypto";
import { isRecord } from "../guards";
import { BACKGROUND_RESULT_FORMAT, EVAL_RESULT_PROTOCOL } from "../compiler/program";

export { BACKGROUND_RESULT_FORMAT };
/** Hard cap for a single result file; larger files are rejected before parsing. */
export const BACKGROUND_RESULT_MAX_BYTES = 32 * 1024 * 1024;

export class BackgroundResultIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackgroundResultIntegrityError";
  }
}

export class BackgroundResultPendingError extends Error {
  constructor(message = "the background result file does not exist yet") {
    super(message);
    this.name = "BackgroundResultPendingError";
  }
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

export interface VerifiedBackgroundResultFile {
  payloadJson: string;
  payload: Record<string, unknown>;
  checksum: string;
  payloadChars: number;
  createdAtMs: number;
}

/** SHA-256 over the UTF-8 bytes of `text`; the cell uses Bun.CryptoHasher. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function fail(message: string): never {
  throw new BackgroundResultIntegrityError(message);
}

/**
 * Parse and verify one result file against the registered group/result id.
 * Throws BackgroundResultIntegrityError for any shape, identity, size, or
 * checksum mismatch.
 */
export function parseBackgroundResultFile(
  text: string,
  expected: { groupId: string; resultId: string },
): VerifiedBackgroundResultFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail("background result file is not valid JSON");
  }
  if (!isRecord(raw)) fail("background result file root must be an object");
  if (raw.format !== BACKGROUND_RESULT_FORMAT) {
    fail(`background result file format must be ${JSON.stringify(BACKGROUND_RESULT_FORMAT)}`);
  }
  if (raw.protocol !== EVAL_RESULT_PROTOCOL) {
    fail(`background result file protocol must be ${JSON.stringify(EVAL_RESULT_PROTOCOL)}`);
  }
  if (raw.groupId !== expected.groupId) {
    fail(
      `background result groupId ${JSON.stringify(raw.groupId)} does not match the registered group ${JSON.stringify(expected.groupId)}`,
    );
  }
  if (raw.resultId !== expected.resultId) {
    fail("background result id does not match the registered result id");
  }
  if (typeof raw.createdAtMs !== "number" || !Number.isFinite(raw.createdAtMs) || raw.createdAtMs <= 0) {
    fail("background result createdAtMs must be a positive number");
  }
  if (typeof raw.payloadJson !== "string") fail("background result payloadJson must be a string");
  const payloadJson = raw.payloadJson;
  // The wrapper stores the payload as a JSON string; byte-length validation
  // happens before read in the store. Character count is checked here because
  // it is cheap and catches malformed wrappers early.
  if (payloadJson.length > BACKGROUND_RESULT_MAX_BYTES) {
    fail(`background result payload is ${payloadJson.length} characters; the limit is ${BACKGROUND_RESULT_MAX_BYTES}`);
  }
  if (raw.payloadChars !== payloadJson.length) {
    fail(
      `background result payloadChars ${JSON.stringify(raw.payloadChars)} does not match the ${payloadJson.length}-character payload`,
    );
  }
  if (typeof raw.sha256 !== "string" || !SHA256_HEX.test(raw.sha256)) {
    fail("background result sha256 must be a 64-character lowercase hex digest");
  }
  const checksum = sha256Hex(payloadJson);
  if (checksum !== raw.sha256) {
    fail("background result failed integrity verification (SHA-256 mismatch)");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    fail("background result payloadJson does not contain valid JSON");
  }
  if (!isRecord(payload)) fail("background result payload must be an object");
  if (payload.protocol !== EVAL_RESULT_PROTOCOL) {
    fail(`background result payload protocol must be ${JSON.stringify(EVAL_RESULT_PROTOCOL)}`);
  }
  if (payload.groupId !== expected.groupId) {
    fail("background result payload groupId does not match the registered group");
  }

  return {
    payloadJson,
    payload,
    checksum,
    payloadChars: payloadJson.length,
    createdAtMs: raw.createdAtMs,
  };
}
