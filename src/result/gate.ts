/**
 * omp-task-group — Result Gate.
 *
 * Controls what actually enters the parent context. Raw child output is never
 * concatenated wholesale; compact/structured/summarize modes bound delivered
 * characters (perTaskChars / maxTotalChars) while preserving agent:// handles
 * so the parent can still read full transcripts on demand.
 */

import type { TaskOutcome } from "../backend/interface";
import type { TaskGroupSpec } from "../schema/task-group";

export interface GateResult {
  /** Text delivered to the parent (one logical continuation). */
  deliveredText: string;
  deliveredChars: number;
  /** Effective mode after fallbacks (summarize → compact on failure). */
  mode: "compact" | "structured" | "summarize";
}

const STATUS_GLYPH: Record<string, string> = {
  succeeded: "✓",
  failed: "✗",
  cancelled: "⊘",
  missing: "…",
};

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)} …[+${text.length - max} chars]`;
}

function outcomeBody(o: TaskOutcome): string {
  if (o.structured !== undefined) {
    try {
      return JSON.stringify(o.structured, null, 0) ?? "";
    } catch {
      return o.result ?? "";
    }
  }
  return o.result ?? o.error ?? "(no output)";
}

function compactTaskBlock(o: TaskOutcome, perTaskChars: number, preserveHandles: boolean): string {
  const glyph = STATUS_GLYPH[o.status] ?? "·";
  const head = `${glyph} ${o.name} · ${o.agent}`;
  const lines = [head];
  if (o.status === "succeeded") {
    const body = clip(outcomeBody(o), perTaskChars);
    if (body.length > 0) lines.push(body);
  } else if (o.error !== undefined) {
    lines.push(`error: ${clip(o.error, 400)}`);
  }
  if (o.durationMs !== undefined) lines.push(`duration: ${(o.durationMs / 1000).toFixed(1)}s${o.resolvedModel ? ` · ${o.resolvedModel}` : ""}`);
  if (preserveHandles && o.handle !== undefined) lines.push(`Full result: ${o.handle}`);
  return lines.join("\n");
}

export function runResultGate(
  outcomes: TaskOutcome[],
  spec: TaskGroupSpec,
  opts: {
    groupState: string;
    summary?: string | undefined;
    groupError?: string | undefined;
    fallbackFromSummarize?: string | undefined;
  },
): GateResult {
  const mode = spec.output.mode;
  if (mode === "structured" && outcomes.some((o) => o.structured !== undefined || o.status !== "succeeded")) {
    const payload = {
      group: opts.groupState,
      tasks: outcomes.map((o) => ({
        name: o.name,
        agent: o.agent,
        status: o.status,
        ...(o.structured !== undefined ? { result: o.structured } : {}),
        ...(o.status !== "succeeded" && o.error !== undefined ? { error: o.error } : {}),
      })),
    };
    let text = JSON.stringify(payload, null, 1);
    if (text.length > spec.output.maxTotalChars) {
      text = clip(text, spec.output.maxTotalChars);
    }
    return { deliveredText: text, deliveredChars: text.length, mode: "structured" };
  }

  if (mode === "summarize" && opts.summary !== undefined) {
    const statusLines = outcomes
      .map((o) => `${STATUS_GLYPH[o.status] ?? "·"} ${o.name} · ${o.agent}${o.handle !== undefined ? ` · ${o.handle}` : ""}`)
      .join("\n");
    const text = clip(
      `Task Group completed (summarized)\n\n${opts.summary}\n\n${statusLines}`,
      spec.output.maxTotalChars,
    );
    return { deliveredText: text, deliveredChars: text.length, mode: "summarize" };
  }

  // Compact (also the fallback for structured-without-schema and summarize-failure).
  const effectivePerTask = Math.min(
    spec.output.perTaskChars,
    Math.max(100, Math.floor(spec.output.maxTotalChars / Math.max(1, outcomes.length))),
  );
  const header = opts.groupError !== undefined ? `Task Group ${opts.groupState} · error` : `Task Group ${opts.groupState}`;
  const blocks = outcomes.map((o) => compactTaskBlock(o, effectivePerTask, spec.output.preserveHandles));
  let body = blocks.join("\n\n");
  if (opts.groupError !== undefined) body += `\n\ngroup error: ${opts.groupError}`;
  if (opts.fallbackFromSummarize !== undefined) body += `\n(note: summarizer unavailable — ${opts.fallbackFromSummarize})`;
  const text = clip(`${header}\n\n${body}`, spec.output.maxTotalChars);
  return { deliveredText: text, deliveredChars: text.length, mode: "compact" };
}
