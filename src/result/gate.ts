/**
 * omp-task-group — Result Gate.
 *
 * Controls what actually enters the parent context. Raw child output is never
 * concatenated wholesale; compact/structured/summarize modes bound delivered
 * characters (perTaskChars / maxTotalChars) while preserving agent:// handles
 * so the parent can still read full transcripts on demand.
 *
 * The algorithm lives in one plain-JavaScript source string (gate-core.ts) that
 * is also emitted into the compiled Eval program. This module instantiates that
 * exact source for foreground results, so foreground and background gates share
 * one implementation.
 */

import type { TaskOutcome } from "../backend/interface";
import type { TaskGroupSpec } from "../schema/task-group";
import { isRecord } from "../guards";
import {
  RESULT_GATE_SOURCE,
  type GateFunction,
  type GateOptions,
  type GateResult,
} from "./gate-core";

export type { GateOptions, GateResult };

let compiledGate: GateFunction | undefined;

function gateFunction(): GateFunction {
  if (compiledGate !== undefined) return compiledGate;
  // The source is a constant defined in this package; no user input is
  // interpolated into it. A Function constructor keeps the host and the Eval
  // cell on the exact same gate implementation.
  const factory = new Function(`${RESULT_GATE_SOURCE}\nreturn tgGateCore;`) as () => unknown;
  const candidate = factory();
  if (typeof candidate !== "function") {
    throw new Error("Result Gate core failed to compile");
  }
  compiledGate = candidate as GateFunction;
  return compiledGate;
}

function validateGateResult(value: unknown): GateResult {
  if (!isRecord(value)) throw new Error("Result Gate core returned a non-object");
  if (typeof value.deliveredText !== "string") {
    throw new Error("Result Gate core returned a non-string deliveredText");
  }
  if (typeof value.deliveredChars !== "number" || value.deliveredChars !== value.deliveredText.length) {
    throw new Error("Result Gate core returned an inconsistent deliveredChars");
  }
  if (value.mode !== "compact" && value.mode !== "structured" && value.mode !== "summarize") {
    throw new Error("Result Gate core returned an invalid mode");
  }
  if (value.error !== undefined && (typeof value.error !== "string" || value.error.length === 0)) {
    throw new Error("Result Gate core returned an invalid gate error");
  }
  return {
    deliveredText: value.deliveredText,
    deliveredChars: value.deliveredChars,
    mode: value.mode,
    ...(value.error !== undefined ? { error: value.error } : {}),
  };
}

export function runResultGate(
  outcomes: TaskOutcome[],
  spec: TaskGroupSpec,
  opts: GateOptions,
): GateResult {
  return validateGateResult(gateFunction()(outcomes, spec, opts));
}
