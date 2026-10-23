/**
 * omp-task-group — Task Group compiler.
 *
 * Compiles a validated TaskGroupSpec into a self-contained JavaScript eval
 * program using only OMP's public eval prelude:
 * agent(), wait(), workpool(), completion(), console.log(), phase(), tool.hub().
 *
 * OMP eval has no display() global. The program emits protocol-tagged JSON
 * chunks as console.log() objects; OMP exposes their JSON views through
 * details.cells[].views[].view.value. Chunks stay below OMP's documented
 * per-cell view count and size limits. Stdout text is not a result channel.
 *
 * Wire payload: { protocol, groupId, strategy, groupState, rawChildChars,
 * outcomes, groupError?, summary?, summaryError? }. Each outcome carries
 * name, agent, status, and optional handle, durationMs, resolvedModel,
 * result, structured, or error. Child content is clipped to
 * output.perTaskChars before it enters the wire payload.
 *
 * Join semantics (per-handle waits are consumed exactly once — that is what
 * suppresses per-child parent wakes):
 *   all + collect    → race until every child settles, no early exit
 *   all + fail_fast  → race loop; first failure cancels the rest
 *   any / quorum     → race loop; condition met cancels the rest
 * A race loop is used uniformly (instead of Promise.all) so a finite
 * execution.concurrency can refill spawn slots as children settle.
 * Pool strategy is only compiled for join=all + collect (atomic batch).
 */

import type { TaskGroupSpec } from "../schema/task-group";

export interface CompileOptions {
  groupId: string;
  summarize?: { model: "smol" | "default" | "slow" } | undefined;
  /** Wall-clock guard marker for runaway groups (ms). */
  maxGroupMs?: number;
}

/** Stable wire payload protocol shared by compiler and result decoder. */
export const EVAL_RESULT_PROTOCOL = "omp-task-group/eval-result-v1";
/** Identifies result chunks carried as OMP eval JSON views. */
export const EVAL_RESULT_TRANSPORT = "omp-task-group/eval-result-view-v1";
/** Keeps a double-escaped JSON view under OMP's 32 KiB per-view limit. */
export const EVAL_RESULT_CHUNK_CHARS = 14_000;
/** OMP v18.12 retains at most 16 JSON views per eval cell. */
export const EVAL_RESULT_MAX_CHUNKS = 16;

function embedJson(value: unknown): string {
  // Double encoding: the JSON.parse argument is itself a JSON string literal,
  // so no character inside the spec can break out of the program syntax.
  return `JSON.parse(${JSON.stringify(JSON.stringify(value))})`;
}

function sharedPrelude(spec: TaskGroupSpec, opts: CompileOptions): string {
  return `
const TG_SPEC = ${embedJson(spec)};
const TG_GROUP = ${JSON.stringify(opts.groupId)};
const TG_PROTOCOL = ${JSON.stringify(EVAL_RESULT_PROTOCOL)};
const TG_RESULT_TRANSPORT = ${JSON.stringify(EVAL_RESULT_TRANSPORT)};
const TG_RESULT_CHUNK_CHARS = ${EVAL_RESULT_CHUNK_CHARS};
const TG_RESULT_MAX_CHUNKS = ${EVAL_RESULT_MAX_CHUNKS};
const TG_SUMMARIZE = ${JSON.stringify(opts.summarize ?? null)};
const TG_MAX_MS = ${JSON.stringify(opts.maxGroupMs ?? 3_600_000)};
const tgStart = Date.now();
// Coarse native status only — never carries result content.
function tgPhase(title) { try { phase(title); } catch (e) {} }
function tgClip(value, n) {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (s === undefined) return undefined;
  if (s.length <= n) return s;
  return s.slice(0, n) + " ...[" + (s.length - n) + " chars truncated]";
}
function tgRawLen(raw) {
  if (typeof raw === "string") return raw.length;
  const s = JSON.stringify(raw ?? null);
  return s === undefined ? String(raw ?? "").length : s.length;
}
function tgPrompt(t) {
  return TG_SPEC.context + "\\n\\n# Your task (" + t.name + ")\\n" + t.task;
}
function tgOpts(t) {
  const o = { agent: t.agent, label: TG_GROUP + "-" + t.name };
  if (t.schema) { o.schema = t.schema; if (t.schemaMode) o.schemaMode = t.schemaMode; }
  if (t.isolated) o.isolated = true;
  if (t.tools && t.tools.length > 0) o.tools = t.tools;
  return o;
}
function tgClassify(r) {
  if (r instanceof Error) {
    const msg = String(r.message || r);
    return { status: /cancel|abort|interrupt/i.test(msg) ? "cancelled" : "failed", error: tgClip(msg, 400) };
  }
  if (r && typeof r === "object" && typeof r.error === "string" && r.result === undefined && r.structured === undefined) {
    return { status: /cancel|abort|interrupt/i.test(r.error) ? "cancelled" : "failed", error: tgClip(r.error, 400) };
  }
  if (typeof r === "string") return { status: "succeeded", result: r };
  return { status: "succeeded", structured: r };
}
// Store a succeeded child's raw value on the outcome, clipped to
// output.perTaskChars. rawLen is the PRE-clip length (feeds rawChildChars).
function tgStoreResult(o, raw) {
  const limit = TG_SPEC.output.perTaskChars;
  o.rawLen = tgRawLen(raw);
  if (typeof raw === "string") { o.result = tgClip(raw, limit); return; }
  if (raw === undefined) return; // succeeded with no content: bare success
  const asJson = JSON.stringify(raw);
  if (asJson === undefined) { o.result = tgClip(String(raw), limit); return; }
  if (asJson.length <= limit) { o.structured = raw; return; }
  o.result = tgClip(asJson, limit);
}
`.trimStart();
}

/**
 * Uniform per-handle wait registry. Every child is waited EXACTLY once —
 * this is the delivery-consumption point that suppresses parent wakes.
 */
const WAIT_REGISTRY = `
const tgHandlePromises = new Map(); // name -> Promise<handle>
const tgHandles = new Map();        // name -> "agent://..." once spawned
const tgWaits = new Map();          // name -> Promise<{name, r?} | {name, e}>
const tgSpawnAt = new Map();        // name -> epoch ms
function tgWaitFor(t, handlePromise) {
  tgSpawnAt.set(t.name, Date.now());
  tgHandlePromises.set(t.name, handlePromise);
  const p = handlePromise.then(
    (h) => {
      tgHandles.set(t.name, h.handle);
      tgPhase("task " + t.name + " running");
      return h.wait().then(
        (r) => ({ name: t.name, r }),
        (e) => ({ name: t.name, e }),
      );
    },
    (err) => ({ name: t.name, e: err, spawnFailed: true }),
  );
  tgWaits.set(t.name, p);
  return p;
}
`.trimStart();

// Shared native eval finalizer. JSON chunks travel through OMP console views.
const ENRICH_AND_FINALIZE = `
async function tgEnrichFromHub() {
  try {
    const tgJobs = await tool.hub({ op: "jobs" });
    const rows = tgJobs && tgJobs.details && Array.isArray(tgJobs.details.jobs) ? tgJobs.details.jobs : [];
    for (const o of tgOutcomes) {
      const row = rows.find((j) => j.id === o.hubId);
      if (row) {
        if (row.resolvedModel) o.resolvedModel = row.resolvedModel;
        if (typeof row.durationMs === "number") o.durationMs = row.durationMs;
      }
    }
  } catch (e) {}
}
function tgFinalize(groupState, extra) {
  const payload = {
    protocol: TG_PROTOCOL,
    groupId: TG_GROUP,
    strategy: extra.strategy,
    groupState,
    rawChildChars: tgOutcomes.reduce((acc, o) => acc + (o.rawLen || 0), 0),
    outcomes: tgOutcomes.map((o) => {
      const c = { name: o.name, agent: o.agent, status: o.status };
      if (o.handle !== undefined) c.handle = o.handle;
      if (o.durationMs !== undefined) c.durationMs = o.durationMs;
      if (o.resolvedModel !== undefined) c.resolvedModel = o.resolvedModel;
      if (o.result !== undefined) c.result = o.result;
      if (o.structured !== undefined) c.structured = o.structured;
      if (o.error !== undefined) c.error = o.error;
      return c;
    }),
  };
  if (extra.groupError !== undefined) payload.groupError = extra.groupError;
  if (extra.summary !== undefined) payload.summary = extra.summary;
  if (extra.summaryError !== undefined) payload.summaryError = extra.summaryError;
  tgEmitResult(payload);
}
function tgEmitResult(payload) {
  const data = JSON.stringify(payload);
  const chunkCount = Math.max(1, Math.ceil(data.length / TG_RESULT_CHUNK_CHARS));
  if (chunkCount > TG_RESULT_MAX_CHUNKS) {
    console.log({
      protocol: TG_PROTOCOL,
      groupId: TG_GROUP,
      transport: TG_RESULT_TRANSPORT,
      overflow: true,
      chunkCount,
      serializedChars: data.length,
    });
    return;
  }
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
    console.log({
      protocol: TG_PROTOCOL,
      groupId: TG_GROUP,
      transport: TG_RESULT_TRANSPORT,
      chunkIndex,
      chunkCount,
      data: data.slice(chunkIndex * TG_RESULT_CHUNK_CHARS, (chunkIndex + 1) * TG_RESULT_CHUNK_CHARS),
    });
  }
}
async function tgMaybeSummarize(extra) {
  if (TG_SPEC.output.mode !== "summarize" || !TG_SUMMARIZE || extra.groupState !== "completed") return;
  try {
    tgPhase("summarizing");
    const corpus = tgOutcomes
      .filter((o) => o.status === "succeeded" && (o.result !== undefined || o.structured !== undefined))
      .map((o) => "## " + o.name + " (" + o.agent + ")\\n" + (o.result !== undefined ? o.result : JSON.stringify(o.structured)))
      .join("\\n\\n");
    const ch = await completion(
      "You compress multi-agent results for one parent continuation. Deduplicate, organize, and extract conclusions. Do not call tools. Return only the digest.\\n\\n" + tgClip(corpus, 24000),
      { model: TG_SUMMARIZE.model },
    );
    const digest = await ch.wait();
    extra.summary = tgClip(String(digest), TG_SPEC.output.maxTotalChars);
  } catch (e) {
    extra.summaryError = tgClip(String(e && e.message ? e.message : e), 200);
  }
}
`.trimStart();

export function compileFanoutProgram(spec: TaskGroupSpec, opts: CompileOptions): string {
  return `
${sharedPrelude(spec, opts)}
${WAIT_REGISTRY}
${ENRICH_AND_FINALIZE}
const TG_CONCURRENCY = TG_SPEC.execution.concurrency === "auto" ? Infinity : TG_SPEC.execution.concurrency;
const tgQueue = TG_SPEC.tasks.slice();
const tgOutcomes = [];

function tgSpawnNext() {
  while (tgWaits.size < TG_CONCURRENCY && tgQueue.length > 0) {
    const t = tgQueue.shift();
    tgWaitFor(t, agent(tgPrompt(t), tgOpts(t)));
  }
}
tgSpawnNext();

function tgSucceeded() { return tgOutcomes.filter((o) => o.status === "succeeded").length; }
function tgFailed() { return tgOutcomes.filter((o) => o.status === "failed").length; }

function tgSettle(entry) {
  const t = TG_SPEC.tasks.find((x) => x.name === entry.name);
  const cls = tgClassify(entry.e !== undefined ? entry.e : entry.r);
  const startedAt = tgSpawnAt.get(entry.name) || tgStart;
  const durationMs = Date.now() - startedAt;
  tgWaits.delete(entry.name);
  const outcome = {
    name: entry.name,
    agent: t ? t.agent : "task",
    status: cls.status,
    durationMs,
    hubId: TG_GROUP + "-" + entry.name,
  };
  const handle = tgHandles.get(entry.name);
  if (handle !== undefined) outcome.handle = handle;
  if (cls.status === "succeeded") {
    tgStoreResult(outcome, entry.r);
  } else {
    outcome.error = cls.error;
  }
  tgPhase("task " + entry.name + " " + outcome.status + (outcome.error ? ": " + tgClip(outcome.error, 160) : ""));
  return outcome;
}

// Cancel still-pending children and reap their waits (consumes deliveries so
// nothing re-delivers to the parent after the group returns).
async function tgCancelAndReap() {
  const pending = Array.from(tgWaits.keys());
  for (const name of pending) {
    try {
      const h = await tgHandlePromises.get(name);
      try { h.cancel(); } catch (e) {}
    } catch (e) {}
  }
  if (tgWaits.size === 0) return;
  const entries = Array.from(tgWaits.entries());
  const gate = Promise.withResolvers();
  setTimeout(gate.resolve, 3000);
  const reaped = await Promise.race([Promise.all(entries.map(([, p]) => p)), gate.promise]);
  if (Array.isArray(reaped)) {
    for (const entry of reaped) tgOutcomes.push(tgSettle(entry));
  }
  for (const name of pending) {
    if (!tgWaits.has(name)) continue;
    tgWaits.delete(name);
    tgOutcomes.push({
      name,
      agent: (TG_SPEC.tasks.find((t) => t.name === name) || {}).agent || "task",
      status: "cancelled",
      error: "cancelled at group exit",
      hubId: TG_GROUP + "-" + name,
    });
    tgPhase("task " + name + " cancelled");
  }
}

async function tgRaceLoop(stopWhen) {
  while (tgWaits.size > 0 || tgQueue.length > 0) {
    tgSpawnNext();
    const winner = await Promise.race(Array.from(tgWaits.values()));
    tgOutcomes.push(tgSettle(winner));
    if (stopWhen()) break;
  }
  if (tgWaits.size > 0) await tgCancelAndReap();
}

let tgGroupState = "completed";
const J = TG_SPEC.join;
const F = TG_SPEC.failure;

if (J.mode === "all" && F.mode === "collect") {
  await tgRaceLoop(() => false);
  tgGroupState = tgSucceeded() > 0 ? "completed" : "failed";
} else if (J.mode === "all" && F.mode === "fail_fast") {
  await tgRaceLoop(() => tgFailed() > 0);
  tgGroupState = tgFailed() > 0 ? "failed" : "completed";
} else if (J.mode === "any") {
  await tgRaceLoop(() => tgSucceeded() >= 1);
  tgGroupState = tgSucceeded() >= 1 ? "completed" : "failed";
} else {
  const q = J.quorum || TG_SPEC.tasks.length;
  await tgRaceLoop(() => tgSucceeded() >= q);
  tgGroupState = tgSucceeded() >= q ? "completed" : "failed";
}

const TG_EXTRA = {
  strategy: "fanout",
  groupState: tgGroupState,
  groupError: Date.now() - tgStart > TG_MAX_MS ? "group exceeded maxGroupMs guard" : undefined,
};
await tgEnrichFromHub();
await tgMaybeSummarize(TG_EXTRA);
tgFinalize(tgGroupState, TG_EXTRA);
`.trimStart();
}

/**
 * Pool program: one homogeneous workpool; coarse progress while running;
 * per-item results recovered from the aggregate job text via hub wait.
 * Only compiled for join=all + collect.
 */
export function compilePoolProgram(spec: TaskGroupSpec, opts: CompileOptions): string {
  return `
${sharedPrelude(spec, opts)}
${ENRICH_AND_FINALIZE}
const TG_TOTAL = TG_SPEC.tasks.length;
const tgOutcomes = [];
const tgPool = await workpool(TG_SPEC.tasks[0].agent, TG_GROUP, TG_SPEC.context);
const tgIds = await tgPool.push(...TG_SPEC.tasks.map((t) => tgPrompt(t)));
tgPhase("pool " + TG_GROUP + " created; items pushed: " + tgIds.length);

function tgParseAggregate(text) {
  // Line state machine over the hub aggregate snapshot:
  //   "- [<key>] <status> ..."  → item begins
  //   fenced block afterwards   → { key: result } when completed
  const items = [];
  const lines = String(text).split("\\n");
  let current = null;
  let fence = null;
  for (const line of lines) {
    if (fence !== null) {
      if (line.trim() === "\`\`\`") {
        if (current && current.json === undefined) {
          // Drop a leading language tag (three backticks + json) if present.
          const body = fence.length > 0 && /^[a-zA-Z0-9]{1,10}$/.test(fence[0]) ? fence.slice(1) : fence;
          current.json = body.join("\\n");
        }
        fence = null;
        continue;
      }
      fence.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("\`\`\`")) { fence = []; continue; }
    const m = trimmed.match(/^- \\[(.+?)\\] (completed|failed|cancelled|error)\\b/);
    if (m) {
      current = { key: m[1], status: m[2] };
      items.push(current);
      continue;
    }
    if (current && current.json === undefined && trimmed.startsWith("{")) {
      current.json = trimmed;
    }
  }
  return items;
}

let tgAggregateText = null;
let tgGroupState = "completed";
while (Date.now() - tgStart < TG_MAX_MS) {
  const snap = await tgPool.status();
  const it = snap && snap.items && typeof snap.items === "object" ? snap.items : {};
  tgPhase("pool " + TG_GROUP + " draining: " + String(it.completed ?? "?") + " completed / " + String(it.running ?? "?") + " running / " + String(it.queued ?? "?") + " queued");
  const r = await tool.hub({ op: "wait", ids: [TG_GROUP], timeoutMs: 20000 });
  const text = r && typeof r.text === "string" ? r.text : "";
  if (/Pool .+completed|Pool queue drained/.test(text)) { tgAggregateText = text; break; }
}
if (tgAggregateText === null) {
  tgGroupState = "failed";
  tgPhase("pool " + TG_GROUP + " aggregate not recovered before maxGroupMs");
  for (const t of TG_SPEC.tasks) {
    tgOutcomes.push({ name: t.name, agent: t.agent, status: "failed", error: "pool aggregate not recovered before maxGroupMs", hubId: TG_GROUP });
  }
} else {
  const parsed = tgParseAggregate(tgAggregateText);
  const byIndex = new Map();
  for (const item of parsed) {
    const m = item.key.match(/#(\\d+)$/);
    if (m) byIndex.set(parseInt(m[1], 10), item);
  }
  let parsedAny = false;
  for (let i = 0; i < TG_TOTAL; i++) {
    const t = TG_SPEC.tasks[i];
    const item = byIndex.get(i + 1);
    const workerHandle = "agent://" + TG_GROUP + "-" + (i + 1);
    if (!item) {
      tgOutcomes.push({ name: t.name, agent: t.agent, status: "failed", error: "item missing from pool aggregate", hubId: TG_GROUP + "-" + (i + 1) + "-b1" });
      tgPhase("task " + t.name + " failed: item missing from pool aggregate");
      continue;
    }
    parsedAny = true;
    if (item.status === "completed" && item.json !== undefined) {
      let value;
      try { value = JSON.parse(item.json); } catch (e) { value = undefined; }
      const hasKey = value !== undefined && Object.prototype.hasOwnProperty.call(value, item.key);
      const raw = hasKey ? value[item.key] : item.json;
      const outcome = { name: t.name, agent: t.agent, status: "succeeded", handle: workerHandle, hubId: TG_GROUP + "-" + (i + 1) + "-b1" };
      tgStoreResult(outcome, raw);
      tgOutcomes.push(outcome);
    } else {
      tgOutcomes.push({ name: t.name, agent: t.agent, status: "failed", error: "pool item " + item.status, handle: workerHandle, hubId: TG_GROUP + "-" + (i + 1) + "-b1" });
      tgPhase("task " + t.name + " failed: pool item " + item.status);
    }
  }
  if (!parsedAny) tgGroupState = "failed";
}

await tgEnrichFromHub();
const TG_EXTRA = { strategy: "pool", groupState: tgGroupState };
await tgMaybeSummarize(TG_EXTRA);
tgFinalize(tgGroupState, TG_EXTRA);
`.trimStart();
}
