/**
 * omp-task-group — strict eval-envelope parser.
 *
 * The Task Group is invoked through the STANDARD eval tool (no shadowed eval):
 * the model writes an envelope as the eval `code`, and the plugin decides what
 * to do with it. This module is the single choke point that reads that code.
 *
 * Grammar (exact — no arbitrary JavaScript):
 *
 *   envelope  ::= WS* "ompTaskGroup" "(" strict-json ")" WS* ";"? WS* EOF
 *   strict-json ::= ONE RFC 8259 JSON value (object, array, string, number,
 *                   true / false / null). The argument is parsed with
 *                   JSON.parse ONLY — it is never evaluated as JavaScript.
 *
 * Allowed: whitespace anywhere outside the JSON value (leading/trailing,
 * between tokens) and at most ONE terminal ";" after the closing ")".
 * Everything else inside the argument must be strict JSON text.
 *
 * Recognition rule: the first non-whitespace token must be exactly the
 * identifier `ompTaskGroup` at an identifier boundary, immediately followed by
 * "(". Code that does not start that way — including code that merely
 * references the name mid-program — is an ordinary eval cell (non-envelope)
 * and must flow through normal eval handling untouched. Code that DOES start
 * the reserved entry point is an envelope attempt: any grammar violation is a
 * recognized malformed envelope (machine-readable code + human message),
 * never a silent pass-through and never an exception.
 *
 * The parser never executes anything, never imports host internals, and is
 * total over `unknown` input: non-string code cannot be an envelope and is
 * classified non-envelope. Schema validation of the parsed spec
 * (schema/task-group validateSpec) happens downstream, before compilation —
 * this module guarantees grammar + strict-JSON well-formedness only.
 */

export const ENVELOPE_NAME = "ompTaskGroup";

/** Stable machine-readable reason for a recognized-but-invalid envelope. */
export type EnvelopeErrorCode =
  /** `ompTaskGroup` not immediately followed by "(" (space, ";", EOF, ".".…). */
  | "expected-open-paren"
  /** No closing ")" before end of input (or an unclosed nested "("). */
  | "unterminated"
  /** `ompTaskGroup()` — the argument is empty / whitespace-only. */
  | "missing-argument"
  /** More than one argument: a top-level "," separates JSON values. */
  | "multiple-arguments"
  /** Argument is not strict JSON (JSON.parse failure; detail carries parser message). */
  | "invalid-json"
  /** Content after the closing ")" beyond whitespace + one terminal ";". */
  | "trailing-content";

export interface EnvelopeParseError {
  readonly code: EnvelopeErrorCode;
  readonly message: string;
  /** JSON.parse diagnostic when code === "invalid-json". */
  readonly detail?: string;
}

export type EnvelopeParseResult =
  /** Not a Task Group envelope — ordinary eval code, handle as usual. */
  | { readonly kind: "non-envelope" }
  /** A recognized envelope attempt that violates the grammar. */
  | { readonly kind: "malformed"; readonly error: EnvelopeParseError }
  /**
   * Grammar-conformant envelope. `spec` is the raw parsed JSON argument value
   * (NOT yet schema-validated); `rawJson` is the exact argument source text
   * between the outer parentheses, whitespace preserved.
   */
  | { readonly kind: "valid"; readonly spec: unknown; readonly rawJson: string };

const IDENT_CONTINUATION = /[A-Za-z0-9_$]/;

function malformed(code: EnvelopeErrorCode, message: string, detail?: string): EnvelopeParseResult {
  return { kind: "malformed", error: detail === undefined ? { code, message } : { code, message, detail } };
}

/**
 * Scan for the ")" that closes the envelope's opening paren, skipping over
 * JSON string literals (a paren inside a string is data, not structure).
 * `openIdx` points at the "(" itself. Returns the close index or -1.
 * Outside strings, a "(" nested in the argument (invalid JSON, but possible
 * in a malformed envelope) keeps the depth above zero so the FIRST top-level
 * ")" is still the real terminator.
 */
function findClosingParen(src: string, openIdx: number): number {
  let depth = 1;
  let inString = false;
  for (let i = openIdx + 1; i < src.length; i++) {
    const ch = src[i] as string;
    if (inString) {
      if (ch === "\\") {
        i += 1; // escaped char (incl. \") — stays inside the string
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * True when `interior` contains a "," outside any string and outside any
 * `{}`/`[]` nesting. Valid JSON can never contain such a comma (commas only
 * separate array/object members), so its presence means multiple arguments
 * (`ompTaskGroup({}, {})`) rather than one JSON value.
 */
function hasTopLevelComma(interior: string): boolean {
  let nesting = 0;
  let inString = false;
  for (let i = 0; i < interior.length; i++) {
    const ch = interior[i] as string;
    if (inString) {
      if (ch === "\\") {
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      nesting += 1;
    } else if (ch === "}" || ch === "]") {
      nesting -= 1;
    } else if (ch === "," && nesting === 0) {
      return true;
    }
  }
  return false;
}

function describeAfterName(afterName: string | undefined): string {
  if (afterName === undefined) return "end of input";
  if (/\s/.test(afterName)) return "whitespace (no space is allowed between the name and the \"(\")";
  return JSON.stringify(afterName);
}

function clip(text: string, n: number): string {
  return text.length <= n ? text : `${text.slice(0, n)}…`;
}

/**
 * Parse eval `code` against the Task Group envelope grammar.
 *
 * Total function: never throws, never evaluates JavaScript. Distinguishes
 * ordinary eval code (`non-envelope`) from recognized-but-invalid envelopes
 * (`malformed`, with code + message) from valid envelopes (`valid`, carrying
 * the raw parsed JSON argument). A valid result is NOT schema-validated here —
 * run `validateSpec` on `spec` downstream before compiling.
 */
export function parseTaskGroupEnvelope(code: unknown): EnvelopeParseResult {
  if (typeof code !== "string") return { kind: "non-envelope" };

  const src = code.trimStart();
  if (!src.startsWith(ENVELOPE_NAME)) return { kind: "non-envelope" };

  const afterName = src[ENVELOPE_NAME.length];
  // A different, longer identifier (ompTaskGroupX) is not our reserved entry.
  if (afterName !== undefined && afterName !== "(" && IDENT_CONTINUATION.test(afterName)) {
    return { kind: "non-envelope" };
  }
  if (afterName !== "(") {
    return malformed(
      "expected-open-paren",
      `'${ENVELOPE_NAME}' must be immediately followed by "(" — found ${describeAfterName(afterName)}; grammar is ${ENVELOPE_NAME}(<strict JSON>)`,
    );
  }

  const closeIdx = findClosingParen(src, ENVELOPE_NAME.length);
  if (closeIdx < 0) {
    return malformed(
      "unterminated",
      `'${ENVELOPE_NAME}' has no closing ")" before the end of input (grammar: ${ENVELOPE_NAME}(<strict JSON>))`,
    );
  }

  const rawJson = src.slice(ENVELOPE_NAME.length + 1, closeIdx);
  if (rawJson.trim().length === 0) {
    return malformed(
      "missing-argument",
      `'${ENVELOPE_NAME}()' requires exactly one strict-JSON argument (grammar: ${ENVELOPE_NAME}(<strict JSON>))`,
    );
  }
  if (hasTopLevelComma(rawJson)) {
    return malformed(
      "multiple-arguments",
      `'${ENVELOPE_NAME}' expects exactly ONE strict-JSON argument, but found values separated by a top-level ","`,
    );
  }

  let spec: unknown;
  try {
    spec = JSON.parse(rawJson) as unknown;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return malformed(
      "invalid-json",
      `'${ENVELOPE_NAME}' argument is not strict JSON: ${detail}`,
      detail,
    );
  }

  // After the closing ")" the grammar allows only whitespace plus at most one
  // terminal ";". Any other character means the envelope is followed by code.
  let rest = src.slice(closeIdx + 1).trimStart();
  if (rest.startsWith(";")) rest = rest.slice(1).trimStart();
  if (rest.length > 0) {
    return malformed(
      "trailing-content",
      `unexpected content after the '${ENVELOPE_NAME}(...)' envelope: ${JSON.stringify(clip(rest, 60))} — only whitespace and one optional terminal ";" are allowed`,
    );
  }

  return { kind: "valid", spec, rawJson };
}
