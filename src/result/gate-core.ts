/**
 * omp-task-group — Result Gate core.
 *
 * This is the single executable definition of the gate. It is emitted verbatim
 * into the compiled Eval program (so an explicitly backgrounded cell gates its
 * own result) and instantiated by the extension host (so foreground results use
 * exactly the same code). Keeping one source string avoids a front/back
 * behavioural drift.
 *
 * Gate invariants:
 * - Per-task status lines, failure previews, the join outcome/group error, and
 *   every requested `agent://` handle are mandatory. They are laid out first
 *   and are never removed by total-length clipping.
 * - Only non-essential body previews are compressed. `maxTotalChars` is a hard
 *   cap: the returned text never exceeds it. Text clipping never splits a
 *   UTF-16 surrogate pair. Optional duration/model adornments are dropped
 *   before any mandatory metadata is hidden.
 * - `structured` output is always valid JSON, including when large child values
 *   are replaced with `{"$truncated":<chars>}` markers.
 * - When the mandatory metadata cannot fit inside `maxTotalChars`, the gate
 *   returns an explicit `error` and failure text instead of a partial result
 *   that looks complete.
 *
 * The function takes plain task outcomes plus the validated spec and returns
 * `{ deliveredText, deliveredChars, mode, error? }`. It intentionally uses only
 * plain JavaScript; TypeScript types live in gate.ts.
 */

import type { TaskOutcome } from "../backend/interface";
import type { TaskGroupSpec } from "../schema/task-group";

export interface GateResult {
  /** Text delivered to the parent (one logical continuation). */
  deliveredText: string;
  deliveredChars: number;
  /** Effective mode after fallbacks (summarize → compact on failure). */
  mode: "compact" | "structured" | "summarize";
  /**
   * Set only when the gate could not represent the mandatory metadata within
   * `output.maxTotalChars`. Callers must surface this as an error; the text is
   * an explicit failure notice, never a partial success.
   */
  error?: string;
}

export interface GateOptions {
  groupState: string;
  summary?: string | undefined;
  groupError?: string | undefined;
  fallbackFromSummarize?: string | undefined;
}

export const RESULT_GATE_SOURCE = String.raw`
function tgGateCore(outcomes, spec, opts) {
  var STATUS_GLYPH = { succeeded: "✓", failed: "✗", cancelled: "⊘", missing: "…" };
  var MAX_TOTAL = spec.output.maxTotalChars;
  var PER_TASK = spec.output.perTaskChars;
  var PRESERVE_HANDLES = spec.output.preserveHandles === true;
  var REQUESTED_MODE = spec.output.mode;
  var ERROR_PREVIEW = 32;
  var HANDLE_PREFIX = "Full result: ";

  function isHighSurrogate(code) { return code >= 0xd800 && code <= 0xdbff; }
  // Slice by UTF-16 code units without ending on a lone high surrogate.
  function safeSlice(text, max) {
    if (max <= 0) return "";
    if (text.length <= max) {
      // Never emit a dangling high surrogate, even if an upstream clip left one.
      return isHighSurrogate(text.charCodeAt(text.length - 1)) ? text.slice(0, -1) : text;
    }
    var end = max;
    if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) {
      end = end - 1;
    }
    return text.slice(0, end);
  }
  // Hard-capped clip: the result is always <= max code units.
  function clip(text, max) {
    if (max <= 0) return "";
    if (text.length <= max) return safeSlice(text, max);
    var keep = max;
    for (var attempt = 0; attempt < 6; attempt++) {
      var head = safeSlice(text, keep);
      var suffix = " …[+" + (text.length - head.length) + " chars]";
      if (head.length + suffix.length <= max) return head + suffix;
      var room = max - suffix.length;
      if (room <= 0) return safeSlice(text, max);
      keep = room;
    }
    return safeSlice(text, max);
  }
  function textOf(o) {
    if (o.structured !== undefined) {
      try {
        var encoded = JSON.stringify(o.structured);
        return encoded === undefined ? "" : encoded;
      } catch (e) {
        return o.result === undefined ? "" : o.result;
      }
    }
    if (o.result !== undefined) return o.result;
    if (o.error !== undefined) return o.error;
    return "(no output)";
  }
  function errorDetail(o, cap) {
    if (o.error === undefined) return undefined;
    if (o.error.length === 0) return "(no detail recorded)";
    return clip(o.error, cap === null ? Math.max(ERROR_PREVIEW, o.error.length) : cap);
  }
  var counts = { succeeded: 0, failed: 0, cancelled: 0, missing: 0 };
  for (var ci = 0; ci < outcomes.length; ci++) {
    var status = outcomes[ci].status;
    if (counts[status] !== undefined) counts[status]++;
  }
  function joinLabel() {
    var join = spec.join || { mode: "all" };
    return join.mode === "quorum" ? "join quorum " + join.quorum : "join " + join.mode;
  }
  function header() {
    var parts = [
      "Task Group " + opts.groupState,
      joinLabel(),
      counts.succeeded + "/" + outcomes.length + " succeeded",
    ];
    if (counts.failed > 0) parts.push(counts.failed + " failed");
    if (counts.cancelled > 0) parts.push(counts.cancelled + " cancelled");
    if (counts.missing > 0) parts.push(counts.missing + " missing");
    return parts.join(" · ");
  }
  function statusLine(o, rich) {
    var line = (STATUS_GLYPH[o.status] || "·") + " " + o.name + " · " + o.agent;
    if (rich) {
      if (o.durationMs !== undefined) line += " · " + (o.durationMs / 1000).toFixed(1) + "s";
      if (o.resolvedModel !== undefined) line += " · " + o.resolvedModel;
    }
    return line;
  }
  // caps maps outcome index -> error preview cap; null means full errors.
  // bodies maps outcome index -> already-budgeted preview line.
  function buildMeta(rich, caps, bodies) {
    var sections = [header()];
    if (opts.groupError !== undefined) sections.push("group error: " + opts.groupError);
    if (opts.fallbackFromSummarize !== undefined) {
      sections.push("note: summarizer unavailable — " + opts.fallbackFromSummarize);
    }
    for (var i = 0; i < outcomes.length; i++) {
      var o = outcomes[i];
      var lines = [statusLine(o, rich)];
      if (o.status !== "succeeded" && o.error !== undefined) {
        lines.push("error: " + errorDetail(o, caps === null ? Math.max(ERROR_PREVIEW, o.error.length) : caps[i]));
      }
      if (PRESERVE_HANDLES && o.handle !== undefined) lines.push(HANDLE_PREFIX + o.handle);
      if (bodies !== undefined && bodies[i] !== undefined && bodies[i].length > 0) lines.push(bodies[i]);
      sections.push(lines.join("\n"));
    }
    return sections.join("\n\n");
  }
  function expandErrorCaps(caps, budget) {
    var next = caps.slice();
    var indexes = [];
    for (var i = 0; i < outcomes.length; i++) {
      var o = outcomes[i];
      if (o.status === "succeeded" || o.error === undefined || o.error.length === 0) continue;
      if (clip(o.error, caps[i]).length < o.error.length) indexes.push(i);
    }
    var remaining = budget;
    var remainingCount = indexes.length;
    for (var j = 0; j < indexes.length; j++) {
      var idx = indexes[j];
      if (remainingCount <= 0) break;
      var share = Math.floor(remaining / remainingCount);
      if (share > 0) {
        var before = clip(outcomes[idx].error, caps[idx]).length;
        var candidate = clip(outcomes[idx].error, caps[idx] + share);
        var delta = candidate.length - before;
        if (delta > 0) {
          next[idx] = caps[idx] + share;
          remaining -= delta;
        }
      }
      remainingCount--;
    }
    return next;
  }
  // Mandatory metadata (status lines + failure previews + handles + join
  // state/error) must fit. Rich metadata (full errors, duration/model) is used
  // only when it fits without squeezing that mandatory set.
  function chooseMeta() {
    var caps = [];
    for (var i = 0; i < outcomes.length; i++) caps.push(ERROR_PREVIEW);
    var lean = buildMeta(false, caps, undefined);
    if (lean.length > MAX_TOTAL) {
      return {
        error:
          "necessary task metadata requires " + lean.length + " characters but maxTotalChars is " + MAX_TOTAL,
      };
    }
    var rich = buildMeta(true, null, undefined);
    if (rich.length <= MAX_TOTAL) return { text: rich, rich: true, caps: null };
    var expanded = expandErrorCaps(caps, MAX_TOTAL - lean.length);
    var meta = buildMeta(false, expanded, undefined);
    if (meta.length > MAX_TOTAL) meta = lean;
    return { text: meta, rich: false, caps: expanded };
  }
  function safeJson(value) {
    try {
      var encoded = JSON.stringify(value);
      return encoded === undefined ? undefined : encoded;
    } catch (e) {
      return undefined;
    }
  }
  function structuredFailure(reason) {
    if (MAX_TOTAL >= 2) {
      var reasonText = reason;
      while (true) {
        var candidate = JSON.stringify({ gateError: reasonText });
        if (candidate.length <= MAX_TOTAL) return candidate;
        if (reasonText.length === 0) break;
        reasonText = safeSlice(reasonText, Math.floor(reasonText.length / 2));
      }
      var fallback = JSON.stringify({ error: "" });
      if (fallback.length <= MAX_TOTAL) return fallback;
      return "{}";
    }
    if (MAX_TOTAL >= 1) return "0";
    return undefined;
  }
  function gateFailure(reason) {
    if (REQUESTED_MODE === "structured") {
      var structuredText = structuredFailure(reason);
      if (structuredText !== undefined) {
        return {
          deliveredText: structuredText,
          deliveredChars: structuredText.length,
          mode: "structured",
          error: reason,
        };
      }
    }
    var notice =
      "Result gate failed: " + reason + " (Task Group " + opts.groupState + "). " +
      "No complete result was delivered; inspect the raw task report or agent:// transcripts.";
    var text = clip(notice, MAX_TOTAL);
    return { deliveredText: text, deliveredChars: text.length, mode: REQUESTED_MODE, error: reason };
  }
  function structuredTask(o, rich, errorCap, resultValue) {
    var task = { name: o.name, agent: o.agent, status: o.status };
    if (rich) {
      if (o.durationMs !== undefined) task.durationMs = o.durationMs;
      if (o.resolvedModel !== undefined) task.resolvedModel = o.resolvedModel;
    }
    if (PRESERVE_HANDLES && o.handle !== undefined) task.handle = o.handle;
    if (o.status !== "succeeded" && o.error !== undefined) task.error = errorDetail(o, errorCap);
    if (resultValue !== undefined) task.result = resultValue;
    return task;
  }
  function structuredPayload(tasks, extra) {
    var payload = {
      group: opts.groupState,
      join: spec.join.mode === "quorum"
        ? { mode: "quorum", quorum: spec.join.quorum }
        : { mode: spec.join.mode },
      counts: {
        succeeded: counts.succeeded,
        failed: counts.failed,
        cancelled: counts.cancelled,
        missing: counts.missing,
        total: outcomes.length,
      },
      tasks: tasks,
    };
    if (opts.groupError !== undefined) payload.groupError = opts.groupError;
    if (opts.fallbackFromSummarize !== undefined) {
      payload.note = "summarizer unavailable — " + opts.fallbackFromSummarize;
    }
    if (extra !== undefined) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) payload[key] = extra[key];
      }
    }
    return payload;
  }
  function structuredGate() {
    var fullTasks = [];
    for (var i = 0; i < outcomes.length; i++) {
      var o = outcomes[i];
      fullTasks.push(structuredTask(o, true, null, o.structured !== undefined ? o.structured : undefined));
    }
    var fullText = safeJson(structuredPayload(fullTasks, undefined));
    if (fullText !== undefined && fullText.length <= MAX_TOTAL) {
      return { deliveredText: fullText, deliveredChars: fullText.length, mode: "structured" };
    }

    var payloadTasks = [];
    var structuredCount = 0;
    for (var j = 0; j < outcomes.length; j++) {
      var outcome = outcomes[j];
      var markerValue;
      if (outcome.structured !== undefined) {
        structuredCount++;
        var serialized = safeJson(outcome.structured);
        markerValue = { "$truncated": serialized === undefined ? -1 : serialized.length };
      }
      payloadTasks.push(structuredTask(outcome, false, ERROR_PREVIEW, markerValue));
    }
    var markerText = JSON.stringify(structuredPayload(payloadTasks, undefined));
    if (markerText.length > MAX_TOTAL) {
      var minimalTasks = [];
      for (var k = 0; k < outcomes.length; k++) {
        minimalTasks.push(structuredTask(outcomes[k], false, ERROR_PREVIEW, undefined));
      }
      var omitted = structuredCount > 0 ? { omittedResults: structuredCount } : undefined;
      var minimalText = JSON.stringify(structuredPayload(minimalTasks, omitted));
      if (minimalText.length <= MAX_TOTAL) {
        return { deliveredText: minimalText, deliveredChars: minimalText.length, mode: "structured" };
      }
      return gateFailure(
        "necessary structured JSON metadata requires " + minimalText.length +
        " characters but maxTotalChars is " + MAX_TOTAL,
      );
    }

    var remaining = MAX_TOTAL - markerText.length;
    // Failure information gets budget before optional child results.
    var errorIndexes = [];
    for (var ei = 0; ei < outcomes.length; ei++) {
      var errorOutcome = outcomes[ei];
      if (errorOutcome.status === "succeeded" || errorOutcome.error === undefined || errorOutcome.error.length === 0) continue;
      if (errorDetail(errorOutcome, ERROR_PREVIEW).length < errorOutcome.error.length) errorIndexes.push(ei);
    }
    var remainingErrors = errorIndexes.length;
    for (var er = 0; er < errorIndexes.length; er++) {
      var errorIdx = errorIndexes[er];
      if (remainingErrors <= 0) break;
      var errorShare = Math.floor(remaining / remainingErrors);
      if (errorShare > 0) {
        var beforeError = payloadTasks[errorIdx].error;
        var expandedError = errorDetail(outcomes[errorIdx], ERROR_PREVIEW + errorShare);
        var errorDelta = JSON.stringify(expandedError).length - JSON.stringify(beforeError).length;
        if (errorDelta > 0 && errorDelta <= errorShare) {
          payloadTasks[errorIdx].error = expandedError;
          remaining -= errorDelta;
        }
      }
      remainingErrors--;
    }

    var resultIndexes = [];
    for (var ri = 0; ri < outcomes.length; ri++) {
      if (outcomes[ri].structured !== undefined) resultIndexes.push(ri);
    }
    var remainingResults = resultIndexes.length;
    for (var rj = 0; rj < resultIndexes.length; rj++) {
      var resultIdx = resultIndexes[rj];
      if (remainingResults <= 0) break;
      var resultShare = Math.floor(remaining / remainingResults);
      if (resultShare > 0) {
        var actual = safeJson(outcomes[resultIdx].structured);
        if (actual !== undefined) {
          var markerJson = JSON.stringify(payloadTasks[resultIdx].result);
          var resultDelta = actual.length - markerJson.length;
          if (resultDelta <= resultShare) {
            payloadTasks[resultIdx].result = outcomes[resultIdx].structured;
            remaining -= resultDelta;
          }
        }
      }
      remainingResults--;
    }

    var text;
    try {
      text = JSON.stringify(structuredPayload(payloadTasks, undefined));
    } catch (e) {
      text = markerText;
    }
    if (text.length > MAX_TOTAL) text = markerText;
    return { deliveredText: text, deliveredChars: text.length, mode: "structured" };
  }
  function compactGate() {
    var choice = chooseMeta();
    if (choice.error !== undefined) return gateFailure(choice.error);
    var bodies = [];
    var previews = [];
    for (var i = 0; i < outcomes.length; i++) {
      if (outcomes[i].status !== "succeeded") continue;
      var body = textOf(outcomes[i]);
      if (body.length > 0) previews.push({ index: i, text: body });
    }
    var remaining = MAX_TOTAL - choice.text.length;
    var remainingPreviews = previews.length;
    var omitted = 0;
    for (var p = 0; p < previews.length; p++) {
      var preview = previews[p];
      var share = Math.floor(remaining / remainingPreviews);
      var allowed = Math.min(PER_TASK, share - 1);
      var previewBody = allowed > 0 ? clip(preview.text, allowed) : "";
      if (previewBody.length > 0) {
        bodies[preview.index] = previewBody;
        remaining -= previewBody.length + 1;
      } else {
        omitted++;
      }
      remainingPreviews--;
    }
    var text = buildMeta(choice.rich, choice.caps, bodies);
    if (text.length > MAX_TOTAL) text = choice.text;
    if (omitted > 0) {
      var note = "\n\n(" + omitted + " task output preview(s) omitted: maxTotalChars budget)";
      if (text.length + note.length <= MAX_TOTAL) text += note;
    }
    return { deliveredText: text, deliveredChars: text.length, mode: "compact" };
  }
  function summarizeGate() {
    var choice = chooseMeta();
    if (choice.error !== undefined) return gateFailure(choice.error);
    if (opts.summary.length === 0) {
      return { deliveredText: choice.text, deliveredChars: choice.text.length, mode: "summarize" };
    }
    var remaining = MAX_TOTAL - choice.text.length;
    var digest = "";
    if (remaining > 2) digest = clip(opts.summary, remaining - 2);
    if (digest.length > 0) {
      var text = choice.text + "\n\n" + digest;
      return { deliveredText: text, deliveredChars: text.length, mode: "summarize" };
    }
    var markers = [
      "\n\n(digest omitted: maxTotalChars budget)",
      "\n\n(digest omitted)",
      "\n\n…",
    ];
    for (var m = 0; m < markers.length; m++) {
      if (choice.text.length + markers[m].length <= MAX_TOTAL) {
        var marked = choice.text + markers[m];
        return { deliveredText: marked, deliveredChars: marked.length, mode: "summarize" };
      }
    }
    return { deliveredText: choice.text, deliveredChars: choice.text.length, mode: "summarize" };
  }

  if (REQUESTED_MODE === "structured" && outcomes.some(function (o) {
    return o.structured !== undefined || o.status !== "succeeded";
  })) {
    return structuredGate();
  }
  if (REQUESTED_MODE === "summarize" && opts.summary !== undefined) {
    return summarizeGate();
  }
  return compactGate();
}
`.trim();

export type GateFunction = (
  outcomes: TaskOutcome[],
  spec: TaskGroupSpec,
  options: GateOptions,
) => GateResult;
