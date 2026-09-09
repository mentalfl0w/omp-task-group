/**
 * omp-task-group — plain-text presenter.
 *
 * Renders a TaskGroupSnapshot as terminal-friendly text. This is the single
 * source for TUI fallback rendering, plain RPC and headless output — the
 * semantic content is identical across presenters because they all consume
 * the same snapshot.
 */

import type { TaskGroupSnapshot, TaskState } from "../state/events";

const GLYPH: Record<TaskState, string> = {
  queued: "…",
  running: "●",
  succeeded: "✓",
  failed: "✗",
  cancelled: "⊘",
};

function shortModel(model: string | undefined): string {
  if (!model) return "";
  const slash = model.lastIndexOf("/");
  const base = slash >= 0 ? model.slice(slash + 1) : model;
  return base.length > 22 ? `${base.slice(0, 21)}…` : base;
}

function fmtDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

export interface SnapshotTextOptions {
  expanded?: boolean;
}

/** Compact one-block rendering (collapsed view). */
export function renderSnapshotText(s: TaskGroupSnapshot, opts: SnapshotTextOptions = {}): string {
  const joinLabel = s.join.mode === "quorum" ? `quorum:${s.join.quorum}` : s.join.mode;
  const head = `Task Group · ${joinLabel} · ${s.strategy}${s.label ? ` · ${s.label}` : ""}`;
  const rows = s.tasks.map((t) => {
    const glyph = GLYPH[t.state];
    const dur = fmtDuration(t.durationMs);
    const model = shortModel(t.resolvedModel);
    const cols = [`${glyph} ${t.name}`, t.agent, t.state === "running" ? "…" : dur, model].filter((x) => x.length > 0);
    return cols.join("  ·  ");
  });
  const done = s.counts.succeeded + s.counts.failed + s.counts.cancelled;
  const foot =
    s.state === "running" || s.state === "joining"
      ? `${done} / ${s.counts.total} settled`
      : `${s.counts.succeeded} succeeded · ${s.counts.failed} failed${s.counts.cancelled > 0 ? ` · ${s.counts.cancelled} cancelled` : ""} · group ${s.state}`;
  const lines = [head, "", ...rows, "", foot];
  if (opts.expanded && s.durationMs !== undefined) {
    lines.push(`group duration: ${fmtDuration(s.durationMs)}`);
  }
  if (s.fallbackReason) lines.push(`note: ${s.fallbackReason}`);
  return lines.join("\n");
}

/** Final result rendering (completed group). */
export function renderFinalText(
  s: TaskGroupSnapshot,
  deliveredText: string,
  opts: SnapshotTextOptions = {},
): string {
  const head = renderSnapshotText(s, opts);
  return `${head}\n\n${deliveredText}`;
}

/** One-line live status (footer / RPC setStatus). */
export function renderStatusLine(s: TaskGroupSnapshot): string {
  const done = s.counts.succeeded + s.counts.failed + s.counts.cancelled;
  return `Task Group ${s.groupId}: ${done}/${s.counts.total}`;
}

/** Widget lines (TUI setWidget / RPC setWidget; cap 10 lines). */
export function renderWidgetLines(s: TaskGroupSnapshot, maxLines = 10): string[] {
  const joinLabel = s.join.mode === "quorum" ? `quorum:${s.join.quorum}` : s.join.mode;
  const lines = [`Task Group · ${joinLabel} · ${s.strategy}`];
  const room = maxLines - 2; // head + footer
  const rows = s.tasks.slice(0, room).map((t) => `${GLYPH[t.state]} ${t.name}`);
  lines.push(...rows);
  const hidden = s.tasks.length - rows.length;
  if (hidden > 0) lines.push(`… +${hidden} more`);
  const done = s.counts.succeeded + s.counts.failed + s.counts.cancelled;
  lines.push(`${done}/${s.counts.total}`);
  return lines;
}
