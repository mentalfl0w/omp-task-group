/**
 * omp-task-group — Task Group compiler.
 *
 * Compiles a validated TaskGroupSpec into a self-contained JavaScript eval
 * program using OMP's public Eval prelude and ordinary `tool.read/wait/write`.
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
 * output.perTaskChars before it enters the wire payload. Background cells add
 * { gateText, gateMode, gatedChars, gateError? } from the shared Result Gate;
 * a present gateError marks an explicit gate failure, never a success.
 *
 * Join semantics (one terminal result is consumed per child before emission,
 * suppressing per-child wakes; failed waits trigger bounded cancellation/reaping):
 *   all + collect    → race until every child settles, no early exit
 *   all + fail_fast  → race loop; first failure cancels the rest
 *   any / quorum     → race loop; condition met cancels the rest
 * A race loop is used uniformly (instead of Promise.all) so a finite
 * execution.concurrency can refill spawn slots as children settle.
 * Pool strategy is only compiled for join=all + collect (atomic batch).
 */

import type { TaskGroupSpec } from "../schema/task-group";
import { RESULT_GATE_SOURCE } from "../result/gate-core";

export interface CompileOptions {
  groupId: string;
  summarize?: { model: "smol" | "default" | "slow" } | undefined;
  /** Wall-clock guard marker for runaway groups (ms). */
  maxGroupMs?: number;
  /** Reason an otherwise eligible Pool plan was downgraded before dispatch. */
  fallbackReason?: string | undefined;
  /**
   * Dispatch phase of a two-phase Workpool background group. The cell only
   * creates the pool, pushes tasks, retains the handle in the shared eval
   * kernel, and returns the verified item ids; it never waits.
   */
  background?: { resultId: string } | undefined;
  /**
   * Collect phase. The cell reads the retained pool handle, reports pending
   * while the pool drains, and on a terminal snapshot writes one checksummed
   * result file atomically. It never waits or consumes any other job.
   */
  collect?: { resultId: string; path: string; storeCapability: string } | undefined;
}

/** Stable wire payload protocol shared by compiler and result decoder. */
export const EVAL_RESULT_PROTOCOL = "omp-task-group/eval-result-v1";
/** Identifies result chunks carried as OMP eval JSON views. */
export const EVAL_RESULT_TRANSPORT = "omp-task-group/eval-result-view-v1";
/** Wrapper written by the host store tool after an explicit collect. */
export const BACKGROUND_RESULT_FORMAT = "omp-task-group/background-result-v1";
/** Single JSON view emitted by the background dispatch cell. */
export const POOL_BACKGROUND_DISPATCH_TRANSPORT = "omp-task-group/pool-background-dispatch-v1";
/** Single JSON view emitted by the background collect cell. */
export const POOL_BACKGROUND_COLLECT_TRANSPORT = "omp-task-group/pool-background-collect-v1";
/** Eval-kernel global holding retained Workpool handles, keyed by group id. */
export const POOL_BACKGROUND_REGISTRY = "__ompTaskGroupPoolBackgroundV1";
/** Keeps a double-escaped JSON view under OMP's 32 KiB per-view limit. */
export const EVAL_RESULT_CHUNK_CHARS = 14_000;
/** Current OMP retains at most 16 JSON views per eval cell. */
export const EVAL_RESULT_MAX_CHUNKS = 16;

function embedJson(value: unknown): string {
  // Double encoding: the JSON.parse argument is itself a JSON string literal,
  // so no character inside the spec can break out of the program syntax.
  return `JSON.parse(${JSON.stringify(JSON.stringify(value))})`;
}

function sharedPrelude(spec: TaskGroupSpec, opts: CompileOptions): string {
  // File-transport constants exist only in the collect cell that can actually
  // write the private result file. Foreground and dispatch cells stay free of
  // dormant file I/O so static safety gates never inspect an unreachable
  // dynamic write path.
  const collect = opts.collect;
  const collectConstants =
    collect === undefined
      ? ""
      : `const TG_BG_RESULT = ${JSON.stringify(collect)};
`;
  return `
const TG_SPEC = ${embedJson(spec)};
const TG_GROUP = ${JSON.stringify(opts.groupId)};
const TG_PROTOCOL = ${JSON.stringify(EVAL_RESULT_PROTOCOL)};
const TG_RESULT_TRANSPORT = ${JSON.stringify(EVAL_RESULT_TRANSPORT)};
const TG_RESULT_CHUNK_CHARS = ${EVAL_RESULT_CHUNK_CHARS};
const TG_RESULT_MAX_CHUNKS = ${EVAL_RESULT_MAX_CHUNKS};
const TG_SUMMARIZE = ${JSON.stringify(opts.summarize ?? null)};
const TG_MAX_MS = ${JSON.stringify(opts.maxGroupMs ?? 3_600_000)};
const TG_REAP_WAIT_S = 10;
const TG_REAP_ATTEMPTS = 3;
const TG_MAX_CANCEL_WAIT_CALLS = 2;
const TG_STATIC_FALLBACK_REASON = ${JSON.stringify(opts.fallbackReason ?? null)};
${collectConstants}
const tgStart = Date.now();
// Coarse native status only — never carries result content.
function tgPhase(title) { try { phase(title); } catch (e) {} }
function tgClip(value, n) {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (s === undefined) return undefined;
  if (s.length <= n) return s;
  let end = n > 0 ? n : 0;
  if (end > 0) {
    const last = s.charCodeAt(end - 1);
    if (last >= 0xD800 && last <= 0xDBFF) end -= 1;
  }
  return s.slice(0, end) + " ...[" + (s.length - end) + " chars truncated]";
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
function tgClassifyError(error) {
  let message;
  if (error instanceof Error) message = String(error.message || error);
  else if (typeof error === "string") message = error || "agent promise rejected with an empty string";
  else if (error === undefined) message = "agent promise rejected without an error value";
  else {
    try { message = JSON.stringify(error) || String(error); }
    catch (e) { message = String(error); }
  }
  return { status: /cancel|abort|interrupt/i.test(message) ? "cancelled" : "failed", error: tgClip(message, 400) };
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
 * Uniform per-handle wait registry. A normal handle is waited once; a wait
 * failure triggers bounded cancellation/reaping so it cannot leave a live child.
 */
const WAIT_REGISTRY = `
const tgHandlePromises = new Map(); // name -> Promise<handle>
const tgWaits = new Map();          // name -> Promise<{name, r?, e?, h?}>
const tgSpawnAt = new Map();        // name -> epoch ms
function tgWaitFor(t, handlePromise) {
  tgSpawnAt.set(t.name, Date.now());
  tgHandlePromises.set(t.name, handlePromise);
  const p = Promise.resolve(handlePromise).then(async (h) => {
    tgPhase("task " + t.name + " running");
    try {
      return { name: t.name, r: await h.wait({ timeout: Math.max(0.001, (TG_MAX_MS - (Date.now() - tgStart)) / 1000) }), h };
    } catch (e) {
      return { name: t.name, e, waitFailed: true, h };
    }
  }, (err) => ({ name: t.name, e: err, spawnFailed: true }));
  tgWaits.set(t.name, p);
  return p;
}
`.trimStart();

// Shared finalizer. OMP JSON views carry only the bounded wire payload.
// File-transport machinery is appended only for the collect cell: dispatch and
// foreground programs contain no dormant file writes, so a static safety gate
// never sees an unreachable dynamic write path.
function resultHelpers(collect: boolean): string {
  const gateDescriber = collect
    ? `
// Mirrors the host decoder's derived group error so the in-cell gate text and
// the host-facing decoded result agree on failed groups.
function tgDescribeGroupFailure(outcomes) {
  var failed = outcomes.filter(function (o) { return o.status === "failed"; }).length;
  var cancelled = outcomes.filter(function (o) { return o.status === "cancelled"; }).length;
  var total = outcomes.length;
  if (failed === 0 && cancelled === 0) {
    return "group failed: join condition unmet — all " + total + " task(s) settled with no recorded failure";
  }
  var text = "group failed: " + failed + "/" + total + " task(s) failed";
  if (cancelled > 0) text += ", " + cancelled + " cancelled";
  var first = null;
  for (var i = 0; i < outcomes.length; i++) {
    var outcome = outcomes[i];
    if (outcome.error !== undefined && outcome.error.length > 0) { first = outcome.error; break; }
  }
  if (first !== null) {
    var cut = 239;
    var lastCode = first.charCodeAt(cut - 1);
    var nextCode = first.charCodeAt(cut);
    if (lastCode >= 0xD800 && lastCode <= 0xDBFF && nextCode >= 0xDC00 && nextCode <= 0xDFFF) cut -= 1;
    var detail = first.length <= 240 ? first : first.slice(0, cut) + "…";
    text += " — " + detail;
  }
  return text;
}
`
    : "";
  const gateEnrichment = collect
    ? `
  var gateGroupError = extra.groupError;
  if (groupState === "failed" && gateGroupError === undefined) {
    gateGroupError = tgDescribeGroupFailure(finalOutcomes);
  }
  if (gateGroupError === undefined && extra.summaryError !== undefined) {
    gateGroupError = "summarizer failed: " + extra.summaryError;
  }
  var gatedGroupState = groupState === "cancelled"
    ? "cancelled"
    : (gateGroupError !== undefined ? "failed" : "completed");
  var gated = tgGateCore(finalOutcomes, TG_SPEC, {
    groupState: gatedGroupState,
    ...(extra.summary !== undefined ? { summary: extra.summary } : {}),
    ...(gateGroupError !== undefined ? { groupError: gateGroupError } : {}),
  });
  payload.gateText = gated.deliveredText;
  payload.gateMode = gated.mode;
  payload.gatedChars = gated.deliveredChars;
  if (gated.error !== undefined) payload.gateError = gated.error;`
    : "";
  const emitResult = collect
    ? `  return await tgStoreBackgroundResult(payload);`
    : `  const data = JSON.stringify(payload);
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
  }`;
  const backgroundTransport = collect
    ? `
// Background transport: the collect cell computes the gate but performs no
// filesystem I/O. It hands the bounded payload to the plugin's write-approved
// tool, which validates group ownership and protocol, then writes atomically.
async function tgStoreBackgroundResult(payload) {
  try {
    if (tool === null || tool === undefined || typeof tool.task_group_store_result !== "function") {
      return { ok: false, error: "the host does not expose task_group_store_result through the Eval tool bridge" };
    }
    const payloadJson = JSON.stringify(payload);
    const result = await tool.task_group_store_result({
      groupId: TG_GROUP,
      resultId: TG_BG_RESULT.resultId,
      storeCapability: TG_BG_RESULT.storeCapability,
      payloadJson,
    });
    if (!result || result.hasError === true) {
      return {
        ok: false,
        error: "the result store rejected this collect: " + tgClip((result && result.text) || "unknown error", 600),
      };
    }
    const details = result.details;
    if (
      !details ||
      details.protocol !== "omp-task-group/background-v1" ||
      details.state !== "ready" ||
      details.groupId !== TG_GROUP ||
      details.resultId !== TG_BG_RESULT.resultId ||
      typeof details.checksum !== "string" ||
      typeof details.payloadChars !== "number"
    ) {
      return { ok: false, error: "the result store returned an unrecognized or mismatched receipt" };
    }
    return { ok: true, checksum: details.checksum, payloadChars: details.payloadChars };
  } catch (e) {
    return { ok: false, error: tgClip(String(e && e.message ? e.message : e), 600) };
  }
}
`
    : "";
  const summarizeHelper = collect
    ? ""
    : `
async function tgMaybeSummarize(outcomes, extra) {
  if (TG_SPEC.output.mode !== "summarize" || !TG_SUMMARIZE || extra.groupState !== "completed") return;
  try {
    tgPhase("summarizing");
    const corpus = outcomes
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
`;
  return `
function tgFinalOutcomes(outcomes) {
  const byName = new Map(outcomes.map((o) => [o.name, o]));
  return TG_SPEC.tasks.map((t) =>
    byName.get(t.name) || {
      name: t.name,
      agent: t.agent,
      status: "failed",
      error: "no final outcome was recorded for this task",
    }
  );
}
${gateDescriber}
async function tgFinalize(groupState, extra, outcomes) {
  const finalOutcomes = tgFinalOutcomes(outcomes);
  const payload = {
    protocol: TG_PROTOCOL,
    groupId: TG_GROUP,
    strategy: extra.strategy,
    groupState,
    rawChildChars: finalOutcomes.reduce((acc, o) => acc + (o.rawLen || 0), 0),
    outcomes: finalOutcomes.map((o) => {
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
  if (extra.fallbackReason !== undefined) payload.fallbackReason = extra.fallbackReason;
  if (extra.groupError !== undefined) payload.groupError = extra.groupError;
  if (extra.summary !== undefined) payload.summary = extra.summary;
  if (extra.summaryError !== undefined) payload.summaryError = extra.summaryError;
${gateEnrichment}
  return await tgEmitResult(payload);
}
async function tgEmitResult(payload) {
${emitResult}
}
${backgroundTransport}
${summarizeHelper}
`.trimStart();
}

const FANOUT_RUNNER = `
const TG_CONCURRENCY = TG_SPEC.execution.concurrency === "auto" ? Infinity : TG_SPEC.execution.concurrency;
const tgQueue = TG_SPEC.tasks.slice();
const tgOutcomeByName = new Map();

function tgSpawnNext() {
  while (tgWaits.size < TG_CONCURRENCY && tgQueue.length > 0 && Date.now() - tgStart < TG_MAX_MS) {
    const t = tgQueue.shift();
    let handlePromise;
    try { handlePromise = agent(tgPrompt(t), tgOpts(t)); }
    catch (e) { handlePromise = Promise.reject(e); }
    tgWaitFor(t, handlePromise);
  }
}

function tgSucceeded() {
  return Array.from(tgOutcomeByName.values()).filter((o) => o.status === "succeeded").length;
}
function tgFailed() {
  return Array.from(tgOutcomeByName.values()).filter((o) => o.status === "failed").length;
}

async function tgRetryFailedWait(handle, initialError, initialStatus) {
  let status = "unknown";
  let lastError = initialError || "unknown wait failure";
  try { status = await handle.status(); } catch (e) {}
  if (status === "running" || status === "unknown") {
    try { await handle.cancel(); }
    catch (e) { lastError = tgClip(String(e && e.message ? e.message : e), 300); }
  }
  for (let attempt = 0; attempt < TG_REAP_ATTEMPTS; attempt++) {
    try {
      return { ok: true, result: await handle.wait({ timeout: TG_REAP_WAIT_S }) };
    } catch (e) {
      lastError = tgClip(String(e && e.message ? e.message : e), 300);
      try { status = await handle.status(); } catch (statusError) {}
      if (status === "running" || status === "unknown") {
        try { await handle.cancel(); }
        catch (cancelError) { lastError = tgClip(String(cancelError && cancelError.message ? cancelError.message : cancelError), 300); }
      }
    }
  }
  return {
    ok: false,
    status: status === "cancelled" ? "cancelled" : status === "failed" || status === "running" ? "failed" : initialStatus,
    error: "handle.wait() could not be reaped after cancellation: " + tgClip(lastError, 300),
  };
}
async function tgSettle(entry, cancelReason) {
  const previous = tgOutcomeByName.get(entry.name);
  tgWaits.delete(entry.name);
  if (previous !== undefined) return previous;
  const t = TG_SPEC.tasks.find((x) => x.name === entry.name);
  let hasError = entry.spawnFailed === true || entry.waitFailed === true;
  let raw = hasError ? entry.e : entry.r;
  let classified = hasError ? tgClassifyError(raw) : tgClassify(raw);
  if (entry.waitFailed === true && entry.h) {
    const recovery = await tgRetryFailedWait(entry.h, classified.error, classified.status);
    if (recovery.ok) {
      raw = recovery.result;
      entry.r = raw;
      hasError = false;
      classified = tgClassify(raw);
    } else {
      hasError = false;
      classified = { status: recovery.status, error: recovery.error };
    }
  }
  if (hasError && entry.h && typeof entry.h.status === "function") {
    try {
      const handleStatus = await entry.h.status();
      if (handleStatus === "cancelled") {
        classified = { status: "cancelled", error: classified.error || "agent handle was cancelled" };
      } else if (handleStatus === "failed") {
        classified.status = "failed";
      } else if (handleStatus === "running") {
        classified = {
          status: "failed",
          error: "handle.wait() failed while the agent was still running: " + tgClip(classified.error || "unknown rejection", 300),
        };
      }
    } catch (e) {}
  }
  if (classified.status === "cancelled" && classified.error === undefined && cancelReason !== undefined) classified.error = cancelReason;
  const startedAt = tgSpawnAt.get(entry.name);
  const outcome = {
    name: entry.name,
    agent: t ? t.agent : "task",
    status: classified.status,
    durationMs: Math.max(0, Date.now() - (startedAt === undefined ? tgStart : startedAt)),
  };
  if (entry.h && typeof entry.h.handle === "string") outcome.handle = entry.h.handle;
  if (classified.status === "succeeded") tgStoreResult(outcome, entry.r);
  else outcome.error = classified.error || "agent did not return a result";
  tgOutcomeByName.set(entry.name, outcome);
  tgPhase("task " + entry.name + " " + outcome.status + (outcome.error ? ": " + tgClip(outcome.error, 160) : ""));
  return outcome;
}

function tgRecordQueuedCancellation(task, reason) {
  if (tgOutcomeByName.has(task.name)) return;
  const outcome = {
    name: task.name,
    agent: task.agent,
    status: "cancelled",
    error: "cancelled before spawn: " + reason,
  };
  tgOutcomeByName.set(task.name, outcome);
  tgPhase("task " + task.name + " cancelled before spawn");
}

async function tgCancelAndReap(reason) {
  const queued = tgQueue.splice(0);
  for (const task of queued) tgRecordQueuedCancellation(task, reason);
  const pendingNames = Array.from(tgWaits.keys());
  await Promise.all(pendingNames.map(async (name) => {
    try {
      const handlePromise = tgHandlePromises.get(name);
      const handle = await handlePromise;
      if (typeof handle.cancel === "function") await handle.cancel();
    } catch (e) {}
  }));
  const entries = await Promise.all(pendingNames.map((name) => tgWaits.get(name)));
  for (const entry of entries) {
    if (entry !== undefined) await tgSettle(entry, reason);
  }
}

async function tgRaceLoop(stopWhen) {
  let timedOut = false;
  while (tgWaits.size > 0 || tgQueue.length > 0) {
    let remaining = TG_MAX_MS - (Date.now() - tgStart);
    if (remaining <= 0) {
      timedOut = true;
      break;
    }
    tgSpawnNext();
    remaining = TG_MAX_MS - (Date.now() - tgStart);
    if (remaining <= 0) {
      timedOut = true;
      break;
    }
    if (tgWaits.size === 0) break;
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), remaining);
    });
    const winner = await Promise.race([...tgWaits.values(), deadline]);
    clearTimeout(timer);
    if (winner === null) {
      timedOut = true;
      break;
    }
    await tgSettle(winner);
    if (Date.now() - tgStart >= TG_MAX_MS) {
      timedOut = true;
      break;
    }
    if (stopWhen()) break;
  }
  if (timedOut) {
    await tgCancelAndReap("group exceeded maxGroupMs guard");
    return true;
  }
  if (tgWaits.size > 0 || tgQueue.length > 0) {
    await tgCancelAndReap("cancelled after join condition was met");
  }
  return false;
}

tgSpawnNext();
const J = TG_SPEC.join;
const F = TG_SPEC.failure;
let tgTimedOut = false;
let tgGroupState = "completed";
if (J.mode === "all" && F.mode === "collect") {
  tgTimedOut = await tgRaceLoop(() => false);
  tgGroupState = !tgTimedOut && tgSucceeded() > 0 ? "completed" : "failed";
} else if (J.mode === "all" && F.mode === "fail_fast") {
  tgTimedOut = await tgRaceLoop(() => tgFailed() > 0);
  tgGroupState = !tgTimedOut && tgFailed() === 0 ? "completed" : "failed";
} else if (J.mode === "any") {
  tgTimedOut = await tgRaceLoop(() => tgSucceeded() >= 1);
  tgGroupState = !tgTimedOut && tgSucceeded() >= 1 ? "completed" : "failed";
} else {
  const q = J.quorum || TG_SPEC.tasks.length;
  tgTimedOut = await tgRaceLoop(() => tgSucceeded() >= q);
  tgGroupState = !tgTimedOut && tgSucceeded() >= q ? "completed" : "failed";
}

const tgOutcomes = TG_SPEC.tasks.map((task) => tgOutcomeByName.get(task.name));
const tgMissing = tgOutcomes.some((outcome) => outcome === undefined);
const tgFinalRows = tgOutcomes.map((outcome, index) =>
  outcome || {
    name: TG_SPEC.tasks[index].name,
    agent: TG_SPEC.tasks[index].agent,
    status: "failed",
    error: "no final outcome was recorded for this task",
  }
);
const tgFallbackReason =
  typeof TG_POOL_FALLBACK_REASON === "string"
    ? TG_POOL_FALLBACK_REASON
    : (typeof TG_STATIC_FALLBACK_REASON === "string" ? TG_STATIC_FALLBACK_REASON : undefined);
const TG_EXTRA = {
  strategy: "fanout",
  groupState: tgGroupState,
  ...(tgFallbackReason !== undefined ? { fallbackReason: tgFallbackReason } : {}),
  ...(tgTimedOut ? { groupError: "group exceeded maxGroupMs guard" } : {}),
  ...(tgMissing ? { groupError: "group ended without one outcome for every task" } : {}),
};
await tgMaybeSummarize(tgFinalRows, TG_EXTRA);
await tgFinalize(tgGroupState, TG_EXTRA, tgFinalRows);
`.trimStart();

export function compileFanoutProgram(spec: TaskGroupSpec, opts: CompileOptions): string {
  return `
${sharedPrelude(spec, opts)}
${WAIT_REGISTRY}
${resultHelpers(false)}
${FANOUT_RUNNER}
`.trimStart();
}

/**
 * Pool is used only for all+collect homogeneous batches. Results come from
 * the public non-consuming peek snapshot; the normal wait tool consumes the
 * pool's owner-scoped aggregate job and its watched batch jobs.
 */
export function compilePoolProgram(spec: TaskGroupSpec, opts: CompileOptions): string {
  const fanoutFallback = FANOUT_RUNNER;
  return `
${sharedPrelude(spec, opts)}
${WAIT_REGISTRY}
${resultHelpers(false)}
async function tgRunFanoutFallback(reason) {
  const TG_POOL_FALLBACK_REASON = reason;
  await (async () => {
${fanoutFallback}
  })();
}

function tgPoolIsRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function tgPoolIsCount(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
function tgPoolSpecReason() {
  if (TG_SPEC.join.mode !== "all" || TG_SPEC.failure.mode !== "collect") {
    return "Pool requires join=all and failure=collect";
  }
  if (TG_SPEC.execution.concurrency !== "auto") {
    return "Pool uses task.maxConcurrency and cannot honor per-group execution.concurrency";
  }
  const first = TG_SPEC.tasks[0];
  if (!first) return "Pool requires at least one task";
  for (const task of TG_SPEC.tasks) {
    if (task.schema !== undefined) return "Pool cannot preserve per-task output schemas; using Fanout";
    if (task.isolated === true) return "Pool cannot preserve per-task worktree isolation; using Fanout";
    if (task.agent !== first.agent) return "Pool requires every task to use the same agent";
    if (JSON.stringify(task.tools || []) !== JSON.stringify(first.tools || [])) {
      return "Pool requires identical per-task tool sets";
    }
  }
  return undefined;
}
function tgPoolStatusReason(status) {
  if (!tgPoolIsRecord(status) || status.name !== TG_GROUP || typeof status.closed !== "boolean") {
    return "Workpool.status() returned an incompatible status object";
  }
  if (!tgPoolIsRecord(status.items) || !Array.isArray(status.agents) || !tgPoolIsCount(status.batches)) {
    return "Workpool.status() omitted item, agent, or batch state";
  }
  for (const key of ["queued", "running", "completed", "failed", "cancelled"]) {
    if (!tgPoolIsCount(status.items[key])) return "Workpool.status() returned an invalid " + key + " count";
  }
  return undefined;
}
function tgPoolPeekReason(snapshot) {
  if (!tgPoolIsRecord(snapshot) || !Array.isArray(snapshot.batches) || !tgPoolIsCount(snapshot.pending)) {
    return "Workpool.peek() returned an incompatible batch snapshot";
  }
  return undefined;
}
async function tgPoolPreflight() {
  const specReason = tgPoolSpecReason();
  if (specReason !== undefined) return { ok: false, reason: specReason };
  if (typeof workpool !== "function" || typeof tool !== "function") {
    return { ok: false, reason: "native Eval does not expose workpool() and tool.* helpers" };
  }
  let result;
  try {
    result = await tool.read({ path: "proc://" });
  } catch (e) {
    return { ok: false, reason: "cannot inspect caller-owned jobs before Pool dispatch: " + tgClip(String(e && e.message ? e.message : e), 240) };
  }
  if (
    !tgPoolIsRecord(result) ||
    result.hasError === true ||
    result.isError === true ||
    !tgPoolIsRecord(result.details)
  ) {
    return { ok: false, reason: "proc:// did not return a verifiable caller-owned job snapshot" };
  }
  const procText = typeof result.text === "string" ? result.text : "";
  if (procText.includes("Services unavailable")) {
    return { ok: false, reason: "proc:// could not verify caller-owned services; using Fanout" };
  }
  const proc = result.details.proc;
  if (!tgPoolIsRecord(proc) || !Array.isArray(proc.jobs) || !Array.isArray(proc.agents) || !Array.isArray(proc.daemons)) {
    return { ok: false, reason: "proc:// job snapshot is missing jobs, agents, or services" };
  }
  for (const job of proc.jobs) {
    if (!tgPoolIsRecord(job) || typeof job.id !== "string" || typeof job.status !== "string") {
      return { ok: false, reason: "proc:// returned an invalid job row; refusing to risk consuming another result" };
    }
    if (job.status === "running" || typeof job.resultText === "string" || typeof job.errorText === "string") {
      return { ok: false, reason: "caller has another waitable job (" + job.id + "); using Fanout to avoid consuming its delivery" };
    }
  }
  for (const agent of proc.agents) {
    if (!tgPoolIsRecord(agent) || typeof agent.live !== "boolean") {
      return { ok: false, reason: "proc:// returned an invalid live-agent row; using Fanout" };
    }
    if (agent.live) return { ok: false, reason: "caller has a live agent that may win wait(); using Fanout" };
  }
  if (typeof tool.wait !== "function") {
    return { ok: false, reason: "native Eval does not expose the public wait tool" };
  }
  // A no-job wait parks on a live service. With our Workpool job active,
  // OMP returns the owned-job snapshot even when a service completion wins.
  if (proc.daemons.length === 0) {
    let waitProbe;
    try {
      waitProbe = await tool.wait({});
    } catch (e) {
      return { ok: false, reason: "the public wait tool is unavailable before Pool dispatch: " + tgClip(String(e && e.message ? e.message : e), 240) };
    }
    const waitDetails = waitProbe && waitProbe.details;
    if (waitProbe && (waitProbe.hasError === true || waitProbe.isError === true)) {
      return { ok: false, reason: "the public wait tool failed its no-work preflight" };
    }
    if (!tgPoolIsRecord(waitDetails) || waitDetails.op !== "wait") {
      return { ok: false, reason: "the public wait tool did not return a verifiable idle snapshot" };
    }
    const waitJobs = Array.isArray(waitDetails.jobs) ? waitDetails.jobs : [];
    if (waitDetails.interrupted === true || waitDetails.waited !== undefined || waitJobs.length > 0) {
      const observed = JSON.stringify({
        jobs: waitJobs.map((job) => tgPoolIsRecord(job) ? job.id : "unknown"),
        waited: waitDetails.waited,
        interrupted: waitDetails.interrupted || undefined,
        text: typeof waitProbe.text === "string" ? waitProbe.text : undefined,
      });
      return { ok: false, reason: "wait preflight observed another result; using Fanout: " + tgClip(observed || "", 500) };
    }
    if (!Array.isArray(waitDetails.jobs)) {
      return { ok: false, reason: "the public wait tool omitted its idle job list" };
    }
  }
  return { ok: true };
}
async function tgCloseUnstartedPool(pool) {
  try { await pool.close(); } catch (e) {}
}
async function tgCancelPool(pool) {
  let dropped = [];
  let cancelError;
  try {
    const closed = await pool.close();
    if (tgPoolIsRecord(closed) && Array.isArray(closed.dropped)) dropped = closed.dropped.filter((id) => typeof id === "string");
  } catch (e) {
    cancelError = "pool.close() failed: " + tgClip(String(e && e.message ? e.message : e), 200);
  }
  try {
    const result = await tool.write({ path: "proc://" + TG_GROUP + "/kill" });
    const proc = result && result.details && result.details.proc;
    const outcomes = proc && Array.isArray(proc.cancelled) ? proc.cancelled : [];
    const target = outcomes.find((item) => tgPoolIsRecord(item) && item.id === TG_GROUP);
    if (!target || target.status !== "cancelled") {
      cancelError = (cancelError ? cancelError + "; " : "") +
        "proc:// kill did not confirm cancellation" +
        (target && typeof target.status === "string" ? " (" + target.status + ")" : "");
    }
  } catch (e) {
    cancelError = (cancelError ? cancelError + "; " : "") + "proc:// kill failed: " + tgClip(String(e && e.message ? e.message : e), 200);
  }
  return { dropped, cancelError };
}
function tgPoolPrompt(task) {
  return "# Your task (" + task.name + ")\\n" + task.task +
    "\\n\\n# Required Task Group result\\n" +
    "After finishing this item, submit exactly one Workpool yield using this item's 1-based batch key. " +
    "Set data to the exact final result as a plain string; do not wrap it in JSON, quotes, or Markdown. " +
    "On failure, use the yield error field with a concise reason. " +
    "Do not put the final result inside a Markdown code fence.";
}
async function tgPoolSnapshot(pool) {
  const status = await pool.status();
  const peek = await pool.peek();
  return { status, peek };
}
async function tgPoolHasWaitableJob(snapshot) {
  let result;
  try { result = await tool.read({ path: "proc://" }); }
  catch (e) { return undefined; }
  if (!tgPoolIsRecord(result) || result.hasError === true || result.isError === true || !tgPoolIsRecord(result.details)) {
    return undefined;
  }
  const text = typeof result.text === "string" ? result.text : "";
  if (text.includes("Services unavailable")) return undefined;
  const proc = result.details.proc;
  if (!tgPoolIsRecord(proc) || !Array.isArray(proc.jobs)) return undefined;
  const ids = new Set([TG_GROUP]);
  for (const batch of snapshot.peek.batches) {
    if (tgPoolIsRecord(batch) && typeof batch.id === "string") ids.add(batch.id);
  }
  for (const job of proc.jobs) {
    if (!tgPoolIsRecord(job) || typeof job.id !== "string" || typeof job.status !== "string") return undefined;
    if (
      ids.has(job.id) &&
      (job.status === "running" || typeof job.resultText === "string" || typeof job.errorText === "string")
    ) return true;
  }
  return false;
}
async function tgWaitForPool(pool, options) {
  const notices = [];
  let timedOut = false;
  let interrupted = false;
  let waitError = options && typeof options.waitError === "string" ? options.waitError : undefined;
  let cancellation;
  let cancelRequested = options && options.cancel === true;
  let waitFailures = 0;
  let cancelWaitCalls = 0;
  let verifyWaitableBeforeNext = false;
  if (cancelRequested) cancellation = await tgCancelPool(pool);
  while (true) {
    if (cancelRequested || verifyWaitableBeforeNext) {
      let snapshot;
      try { snapshot = await tgPoolSnapshot(pool); }
      catch (e) {
        waitError = waitError || "Workpool status/peek failed after cancellation: " + tgClip(String(e && e.message ? e.message : e), 300);
        return { status: undefined, peek: undefined, notices, timedOut, interrupted, waitError, cancellation };
      }
      const statusError = tgPoolStatusReason(snapshot.status);
      const peekError = tgPoolPeekReason(snapshot.peek);
      if (statusError || peekError) {
        waitError = waitError || statusError || peekError;
        return { status: snapshot.status, peek: snapshot.peek, notices, timedOut, interrupted, waitError, cancellation };
      }
      const waitable = await tgPoolHasWaitableJob(snapshot);
      if (waitable !== true) {
        if (!cancelRequested) {
          cancelRequested = true;
          cancellation = await tgCancelPool(pool);
        }
        waitError = waitError || (
          waitable === false
            ? "no waitable aggregate or batch job remains after tool.wait()"
            : "cannot verify a waitable Pool job after tool.wait()"
        );
        let finalSnapshot = snapshot;
        try { finalSnapshot = await tgPoolSnapshot(pool); } catch (e) {}
        return {
          status: finalSnapshot.status,
          peek: finalSnapshot.peek,
          notices,
          timedOut,
          interrupted,
          waitError,
          cancellation,
        };
      }
      verifyWaitableBeforeNext = false;
    }
    const remaining = TG_MAX_MS - (Date.now() - tgStart);
    if (!cancelRequested && remaining <= 0) {
      timedOut = true;
      cancelRequested = true;
      cancellation = await tgCancelPool(pool);
      continue;
    }
    if (cancelRequested) {
      if (cancelWaitCalls >= TG_MAX_CANCEL_WAIT_CALLS) {
        waitError = waitError || "Pool remained active after the bounded cancellation waits";
        let finalSnapshot = { status: undefined, peek: undefined };
        try { finalSnapshot = await tgPoolSnapshot(pool); } catch (e) {}
        return { status: finalSnapshot.status, peek: finalSnapshot.peek, notices, timedOut, interrupted, waitError, cancellation };
      }
      cancelWaitCalls++;
    }
    const waitPromise = Promise.resolve().then(() => tool.wait({}));
    let raced;
    if (cancelRequested) {
      raced = await waitPromise.then(
        (value) => ({ kind: "result", value }),
        (error) => ({ kind: "error", error }),
      );
    } else {
      let timer;
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), remaining);
      });
      raced = await Promise.race([
        waitPromise.then((value) => ({ kind: "result", value }), (error) => ({ kind: "error", error })),
        deadline,
      ]);
      clearTimeout(timer);
      if (raced.kind === "timeout") {
        timedOut = true;
        cancelRequested = true;
        cancellation = await tgCancelPool(pool);
        cancelWaitCalls++;
        raced = await waitPromise.then(
          (value) => ({ kind: "result", value }),
          (error) => ({ kind: "error", error }),
        );
      }
    }
    if (raced.kind === "error") {
      waitFailures++;
      waitError = waitError || tgClip(String(raced.error && raced.error.message ? raced.error.message : raced.error), 400);
      if (!cancelRequested) {
        cancelRequested = true;
        cancellation = await tgCancelPool(pool);
      }
      if (waitFailures > 2) {
        let finalSnapshot = { status: undefined, peek: undefined };
        try { finalSnapshot = await tgPoolSnapshot(pool); } catch (e) {}
        return { status: finalSnapshot.status, peek: finalSnapshot.peek, notices, timedOut, interrupted, waitError, cancellation };
      }
      continue;
    }
    const result = raced.value;
    const details = result && result.details;
    if (!tgPoolIsRecord(details) || details.op !== "wait") {
      waitError = waitError || "tool.wait() returned a non-wait result while a Workpool was active: " + tgClip(JSON.stringify(result) || String(result), 500);
      if (!cancelRequested) {
        cancelRequested = true;
        cancellation = await tgCancelPool(pool);
        continue;
      }
      let finalSnapshot = { status: undefined, peek: undefined };
      try { finalSnapshot = await tgPoolSnapshot(pool); } catch (e) {}
      return { status: finalSnapshot.status, peek: finalSnapshot.peek, notices, timedOut, interrupted, waitError, cancellation };
    }
    const waitJobs = Array.isArray(details.jobs) ? details.jobs : [];
    const hasWaitMessage = details.waited !== undefined;
    if (!Array.isArray(details.jobs) && !hasWaitMessage && details.interrupted !== true) {
      waitError = waitError || "tool.wait() omitted jobs and did not report a peer message or interrupt";
      if (!cancelRequested) {
        cancelRequested = true;
        cancellation = await tgCancelPool(pool);
        continue;
      }
      let finalSnapshot = { status: undefined, peek: undefined };
      try { finalSnapshot = await tgPoolSnapshot(pool); } catch (e) {}
      return { status: finalSnapshot.status, peek: finalSnapshot.peek, notices, timedOut, interrupted, waitError, cancellation };
    }
    if (details.interrupted === true) {
      interrupted = true;
      notices.push("tool.wait() was interrupted by steering");
      if (!cancelRequested) {
        cancelRequested = true;
        cancellation = await tgCancelPool(pool);
      }
    }
    if (hasWaitMessage) {
      const message = JSON.stringify(details.waited);
      notices.push("peer message consumed while joining Pool: " + tgClip(message || String(details.waited), 400));
    }
    let snapshot;
    try {
      snapshot = await tgPoolSnapshot(pool);
    } catch (e) {
      waitError = waitError || "Workpool status/peek failed: " + tgClip(String(e && e.message ? e.message : e), 300);
      if (!cancelRequested) {
        cancelRequested = true;
        cancellation = await tgCancelPool(pool);
        continue;
      }
      let finalSnapshot = { status: undefined, peek: undefined };
      try { finalSnapshot = await tgPoolSnapshot(pool); } catch (e) {}
      return { status: finalSnapshot.status, peek: finalSnapshot.peek, notices, timedOut, interrupted, waitError, cancellation };
    }
    const statusError = tgPoolStatusReason(snapshot.status);
    const peekError = tgPoolPeekReason(snapshot.peek);
    if (statusError || peekError) {
      waitError = waitError || statusError || peekError;
      if (!cancelRequested) {
        cancelRequested = true;
        cancellation = await tgCancelPool(pool);
        continue;
      }
      return { status: snapshot.status, peek: snapshot.peek, notices, timedOut, interrupted, waitError, cancellation };
    }
    const knownBatchIds = new Set(snapshot.peek.batches.map((batch) => tgPoolIsRecord(batch) && typeof batch.id === "string" ? batch.id : ""));
    const jobs = waitJobs.filter(tgPoolIsRecord);
    const foreign = jobs.filter((job) => job.id !== TG_GROUP && !knownBatchIds.has(job.id));
    if (foreign.length > 0) {
      const descriptions = foreign.map((job) =>
        String(job.id || "unknown") + ": " + tgClip(String(job.errorText || job.resultText || job.label || "unavailable"), 160)
      );
      waitError = waitError || "wait consumed unrelated result(s): " + descriptions.join(" | ");
      if (!cancelRequested) {
        cancelRequested = true;
        cancellation = await tgCancelPool(pool);
      }
    }
    const groupJob = jobs.find((job) => job.id === TG_GROUP);
    if (groupJob && groupJob.status !== "running") {
      if (!["completed", "failed", "cancelled"].includes(groupJob.status)) {
        waitError = waitError || "wait() returned an unknown Workpool terminal status";
      }
      return {
        status: snapshot.status,
        peek: snapshot.peek,
        notices,
        timedOut,
        interrupted,
        waitError,
        cancellation,
        terminalStatus: groupJob.status,
        terminalError: typeof groupJob.errorText === "string" ? groupJob.errorText : undefined,
      };
    }

    if (jobs.length === 0) {
      if (!hasWaitMessage && details.interrupted !== true) {
        waitError = waitError || "wait() returned no caller-owned Workpool or batch job while Pool items were pending";
        if (!cancelRequested) {
          cancelRequested = true;
          cancellation = await tgCancelPool(pool);
        }
      }
      verifyWaitableBeforeNext = true;
      continue;
    }
    tgPhase(
      "pool " + TG_GROUP + " draining: " +
        String(snapshot.status.items.completed) + " completed / " +
        String(snapshot.status.items.failed) + " failed / " +
        String(snapshot.status.items.cancelled) + " cancelled",
    );
  }
}
function tgPoolHasDuplicateJsonKeys(text) {
  let index = 0;
  let duplicate = false;
  function skipSpace() {
    while (text[index] === " " || text[index] === "\\n" || text[index] === "\\r" || text[index] === "\\t") index++;
  }
  function readString() {
    const start = index++;
    let escaped = false;
    while (index < text.length) {
      const ch = text[index++];
      if (escaped) escaped = false;
      else if (ch === "\\\\") escaped = true;
      else if (ch === "\\"") return JSON.parse(text.slice(start, index));
    }
    return "";
  }
  function scanValue() {
    skipSpace();
    const ch = text[index];
    if (ch === "{") {
      index++;
      skipSpace();
      const keys = new Set();
      if (text[index] === "}") { index++; return; }
      while (index < text.length) {
        skipSpace();
        const key = readString();
        if (keys.has(key)) duplicate = true;
        keys.add(key);
        skipSpace();
        index++;
        scanValue();
        skipSpace();
        if (text[index] === ",") { index++; continue; }
        if (text[index] === "}") { index++; return; }
        return;
      }
      return;
    }
    if (ch === "[") {
      index++;
      skipSpace();
      if (text[index] === "]") { index++; return; }
      while (index < text.length) {
        scanValue();
        skipSpace();
        if (text[index] === ",") { index++; continue; }
        if (text[index] === "]") { index++; return; }
        return;
      }
      return;
    }
    if (ch === "\\"") { readString(); return; }
    while (
      index < text.length &&
      text[index] !== " " && text[index] !== "\\n" && text[index] !== "\\r" && text[index] !== "\\t" &&
      text[index] !== "," && text[index] !== "}" && text[index] !== "]"
    ) index++;
  }
  try { scanValue(); } catch (e) { return false; }
  return duplicate;
}
// The two exact wire envelopes a Workpool batch value may encode. Anything
// else is the worker's own JSON text and must stay text, not become structured.
function tgPoolIsProtocolEnvelope(value) {
  if (!tgPoolIsRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 1) return typeof value.error === "string";
  return keys.length === 2 &&
    value.status === "succeeded" &&
    Object.prototype.hasOwnProperty.call(value, "value");
}
function tgPoolCoversItems(output, batch) {
  const itemIds = batch.items.filter((id) => typeof id === "string");
  const keys = Object.keys(output);
  return keys.length === itemIds.length &&
    itemIds.every((id) => Object.prototype.hasOwnProperty.call(output, id)) &&
    keys.every((id) => itemIds.includes(id));
}
// A failed batch carries its native diagnostic in its output field (the
// worker's error text, or a schema-violation JSON object). The item-envelope
// map is not a diagnostic: the pool already marked every item failed.
function tgPoolBatchDiagnostic(batch) {
  if (typeof batch.output !== "string" || batch.output.length === 0) return undefined;
  if (!tgPoolHasDuplicateJsonKeys(batch.output)) {
    let parsed;
    try { parsed = JSON.parse(batch.output); }
    catch (e) { parsed = undefined; }
    if (tgPoolIsRecord(parsed)) {
      if (tgPoolCoversItems(parsed, batch)) return undefined;
      if (typeof parsed.message === "string" && parsed.message.length > 0) return tgClip(parsed.message, 400);
      if (typeof parsed.error === "string" && parsed.error.length > 0) return tgClip(parsed.error, 400);
    }
  }
  return tgClip(batch.output, 400);
}
function tgPoolDecode(ids, snapshot, waitState) {
  const outcomesByName = new Map();
  const expectedIds = new Set();
  const issues = [];
  const duplicatePushIds = new Set();
  const dropped = new Set(waitState.cancellation && Array.isArray(waitState.cancellation.dropped) ? waitState.cancellation.dropped : []);
  if (!Array.isArray(ids) || ids.length !== TG_SPEC.tasks.length || ids.some((id) => typeof id !== "string" || id.length === 0)) {
    issues.push("Workpool.push() did not return exactly one non-empty string id per task");
  } else {
    for (let index = 0; index < ids.length; index++) {
      const id = ids[index];
      if (expectedIds.has(id)) {
        issues.push("Workpool.push() returned duplicate item id " + id);
        duplicatePushIds.add(id);
      }
      expectedIds.add(id);
    }
  }
  const assignments = new Map();
  const parsedBatches = new Map();
  const seenBatchIds = new Set();
  const batches = snapshot && tgPoolIsRecord(snapshot) && Array.isArray(snapshot.peek && snapshot.peek.batches)
    ? snapshot.peek.batches
    : [];
  for (const batch of batches) {
    if (!tgPoolIsRecord(batch) || typeof batch.id !== "string" || typeof batch.agent !== "string" || !Array.isArray(batch.items)) {
      issues.push("Workpool.peek() returned a malformed batch");
      continue;
    }
    if (seenBatchIds.has(batch.id)) issues.push("Workpool.peek() repeated batch id " + batch.id);
    seenBatchIds.add(batch.id);
    if (!["running", "completed", "failed", "cancelled"].includes(batch.status)) {
      issues.push("Workpool batch " + batch.id + " has an unknown status");
    }
    for (const id of batch.items) {
      if (typeof id !== "string" || !expectedIds.has(id)) {
        issues.push("Workpool batch " + batch.id + " contained an unknown item id");
        continue;
      }
      if (assignments.has(id)) {
        issues.push("Workpool item " + id + " appeared in more than one batch");
        assignments.set(id, { duplicate: true, batch });
      } else {
        assignments.set(id, { batch });
      }
    }
    if (batch.status !== "completed") {
      // A terminal failed/cancelled batch is a legitimate group outcome, not
      // a protocol failure. Its items are mapped to failed/cancelled below;
      // a failed batch keeps its bounded native diagnostic for the gate.
      const diagnostic = batch.status === "failed" ? tgPoolBatchDiagnostic(batch) : undefined;
      parsedBatches.set(batch.id, { terminal: batch.status, diagnostic: diagnostic });
      continue;
    }
    if (typeof batch.output !== "string") {
      parsedBatches.set(batch.id, { error: "Workpool batch output is missing" });
      continue;
    }
    if (tgPoolHasDuplicateJsonKeys(batch.output)) {
      parsedBatches.set(batch.id, { error: "Workpool batch output contains duplicate JSON object keys" });
      continue;
    }
    let output;
    try { output = JSON.parse(batch.output); }
    catch (e) {
      parsedBatches.set(batch.id, { error: "Workpool batch output is invalid or truncated JSON" });
      continue;
    }
    if (!tgPoolIsRecord(output)) {
      parsedBatches.set(batch.id, { error: "Workpool batch output is not a JSON object" });
      continue;
    }
    if (!tgPoolCoversItems(output, batch)) {
      parsedBatches.set(batch.id, { error: "Workpool batch output did not cover exactly its declared item ids" });
      continue;
    }
    parsedBatches.set(batch.id, { output });
  }
  for (const [batchId, decoded] of parsedBatches) {
    if (decoded.error) issues.push("Workpool batch " + batchId + ": " + decoded.error);
  }
  for (let index = 0; index < TG_SPEC.tasks.length; index++) {
    const task = TG_SPEC.tasks[index];
    const id = Array.isArray(ids) ? ids[index] : undefined;
    let outcome;
    if (typeof id !== "string" || id.length === 0) {
      outcome = { name: task.name, agent: task.agent, status: "failed", error: "Workpool item id is unavailable" };
    } else if (duplicatePushIds.has(id)) {
      outcome = { name: task.name, agent: task.agent, status: "failed", error: "Workpool.push() duplicated item id " + id };
    } else if (dropped.has(id)) {
      outcome = { name: task.name, agent: task.agent, status: "cancelled", error: "Workpool item was queued when the pool closed" };
    } else {
      const assignment = assignments.get(id);
      const batch = assignment && assignment.batch;
      const decoded = batch && parsedBatches.get(batch.id);
      if (!assignment) {
        outcome = { name: task.name, agent: task.agent, status: "failed", error: "Workpool.peek() omitted item " + id };
      } else if (assignment.duplicate) {
        outcome = { name: task.name, agent: task.agent, status: "failed", error: "Workpool.peek() duplicated item " + id };
      } else if (batch.status === "cancelled") {
        outcome = { name: task.name, agent: task.agent, status: "cancelled", error: "Workpool batch was cancelled", handle: "agent://" + batch.agent };
      } else if (batch.status === "failed") {
        outcome = {
          name: task.name,
          agent: task.agent,
          status: "failed",
          error: decoded && decoded.diagnostic ? decoded.diagnostic : "Workpool worker batch failed",
          handle: "agent://" + batch.agent,
        };
      } else if (!decoded || decoded.error || !tgPoolIsRecord(decoded.output)) {
        outcome = {
          name: task.name,
          agent: task.agent,
          status: "failed",
          error: decoded && decoded.error ? decoded.error : "Workpool batch result could not be verified",
          handle: typeof batch.agent === "string" ? "agent://" + batch.agent : undefined,
        };
      } else {
        let envelope = decoded.output[id];
        if (typeof envelope === "string") {
          try {
            if (!tgPoolHasDuplicateJsonKeys(envelope)) {
              const parsedEnvelope = JSON.parse(envelope);
              // Only the exact protocol envelopes are unwrapped; any other
              // JSON-object text is the worker's literal result and stays text.
              if (tgPoolIsProtocolEnvelope(parsedEnvelope)) envelope = parsedEnvelope;
            }
          } catch (e) {}
        }
        if (
          tgPoolIsRecord(envelope) &&
          envelope.status === "succeeded" &&
          Object.prototype.hasOwnProperty.call(envelope, "value") &&
          Object.keys(envelope).length === 2
        ) {
          outcome = { name: task.name, agent: task.agent, status: "succeeded", handle: "agent://" + batch.agent };
          tgStoreResult(outcome, envelope.value);
        } else if (
          tgPoolIsRecord(envelope) &&
          typeof envelope.error === "string" &&
          Object.keys(envelope).length === 1
        ) {
          outcome = {
            name: task.name,
            agent: task.agent,
            status: "failed",
            error: tgClip(envelope.error, 400),
            handle: "agent://" + batch.agent,
          };
        } else if (envelope !== undefined) {
          // Apart from the reserved one-field {error} failure envelope, any
          // defined Workpool yield is task data and must be preserved verbatim.
          outcome = { name: task.name, agent: task.agent, status: "succeeded", handle: "agent://" + batch.agent };
          tgStoreResult(outcome, envelope);
        } else {
          outcome = {
            name: task.name,
            agent: task.agent,
            status: "failed",
            error: "Workpool item " + id + " returned no result envelope",
            handle: "agent://" + batch.agent,
          };
        }
      }
    }
    outcomesByName.set(task.name, outcome);
  }
  const outcomes = TG_SPEC.tasks.map((task) => outcomesByName.get(task.name));
  const itemCounts = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const outcome of outcomes) {
    if (!outcome) continue;
    const state = outcome.status === "succeeded" ? "completed" : outcome.status;
    if (itemCounts[state] !== undefined) itemCounts[state]++;
  }
  if (!tgPoolIsRecord(snapshot.status) || !tgPoolIsRecord(snapshot.status.items)) {
    issues.push("Workpool.status() item counts are missing");
  } else {
    // A completed Workpool item may yield a logical error envelope. Workpool
    // counts that item as completed while the decoded outcome is failed, so
    // requiring per-status equality would reject legitimate partial failures.
    const terminalCount =
      snapshot.status.items.completed + snapshot.status.items.failed + snapshot.status.items.cancelled;
    if (terminalCount !== outcomes.length) {
      issues.push("Workpool terminal item counts do not cover the task set");
    }
    if (snapshot.status.items.cancelled !== itemCounts.cancelled) {
      issues.push("Workpool status cancelled count disagrees with item results");
    }
    if (snapshot.status.items.failed > itemCounts.failed) {
      issues.push("Workpool status failed count exceeds item results");
    }
    if (snapshot.status.closed !== true) issues.push("Workpool was not closed after its aggregate job settled");
    if (snapshot.status.items.queued !== 0 || snapshot.status.items.running !== 0) {
      issues.push("Workpool still reports queued or running items after wait()");
    }
  }
  if (!tgPoolIsRecord(snapshot.peek) || snapshot.peek.pending !== 0) {
    issues.push("Workpool.peek() still reports pending items after wait()");
  }
  if (
    tgPoolIsRecord(snapshot.status) &&
    tgPoolIsRecord(snapshot.peek) &&
    Array.isArray(snapshot.peek.batches) &&
    snapshot.status.batches !== snapshot.peek.batches.length
  ) {
    issues.push("Workpool status batch count disagrees with peek()");
  }
  if (waitState.terminalStatus === "failed") {
    issues.push("Workpool aggregate job failed" + (waitState.terminalError ? ": " + waitState.terminalError : ""));
  }
  if (waitState.waitError) issues.push(waitState.waitError);
  if (waitState.timedOut) issues.push("Workpool exceeded maxGroupMs and was cancelled");
  if (waitState.interrupted) issues.push("Workpool wait was interrupted and the pool was cancelled");
  if (waitState.cancellation && waitState.cancellation.cancelError) issues.push(waitState.cancellation.cancelError);
  for (const notice of waitState.notices || []) issues.push(notice);
  const uniqueIssues = Array.from(new Set(issues));
  const succeeded = outcomes.filter((outcome) => outcome && outcome.status === "succeeded").length;
  const cancelled = outcomes.filter((outcome) => outcome && outcome.status === "cancelled").length;
  const groupState =
    waitState.interrupted ? "cancelled" :
    waitState.timedOut ? "failed" :
    waitState.terminalStatus === "cancelled" ? "cancelled" :
    uniqueIssues.length > 0 ? "failed" :
    succeeded > 0 ? "completed" :
    // Same rule as the background decoder: every settled item cancelled is a
    // cancelled group, not a failure (a killed pool can drain without its
    // aggregate job status being reported as cancelled).
    cancelled === outcomes.length ? "cancelled" : "failed";
  return {
    outcomes,
    groupState,
    groupError: uniqueIssues.length > 0 ? tgClip(uniqueIssues.join("; "), 1200) : undefined,
  };
}

const tgPreflight = await tgPoolPreflight();
if (!tgPreflight.ok) {
  tgPhase("Pool preflight fallback: " + tgPreflight.reason);
  await tgRunFanoutFallback(tgPreflight.reason);
  return;
}
const firstTask = TG_SPEC.tasks[0];
const tgPoolOptions = { name: TG_GROUP, context: TG_SPEC.context };
if (Array.isArray(firstTask.tools) && firstTask.tools.length > 0) tgPoolOptions.tools = firstTask.tools;
let tgPool;
try {
  tgPool = await workpool(firstTask.agent, tgPoolOptions);
} catch (e) {
  tgPhase("Pool create failed before dispatch; falling back to Fanout");
  await tgRunFanoutFallback("workpool create failed before dispatch: " + tgClip(String(e && e.message ? e.message : e), 240));
  return;
}
if (
  !tgPool ||
  typeof tgPool.push !== "function" ||
  typeof tgPool.status !== "function" ||
  typeof tgPool.peek !== "function" ||
  typeof tgPool.close !== "function"
) {
  await tgCloseUnstartedPool(tgPool);
  await tgRunFanoutFallback("workpool object lacks the documented push/status/peek/close methods");
  return;
}
let initialStatus;
let initialPeek;
try {
  initialStatus = await tgPool.status();
  initialPeek = await tgPool.peek();
} catch (e) {
  await tgCloseUnstartedPool(tgPool);
  await tgRunFanoutFallback("workpool status/peek preflight failed before dispatch: " + tgClip(String(e && e.message ? e.message : e), 240));
  return;
}
const initialStatusError = tgPoolStatusReason(initialStatus);
const initialPeekError = tgPoolPeekReason(initialPeek);
if (
  initialStatusError ||
  initialPeekError ||
  initialStatus.closed !== false ||
  initialStatus.batches !== 0 ||
  initialPeek.pending !== 0 ||
  initialPeek.batches.length !== 0 ||
  ["queued", "running", "completed", "failed", "cancelled"].some((key) => initialStatus.items[key] !== 0)
) {
  await tgCloseUnstartedPool(tgPool);
  await tgRunFanoutFallback(initialStatusError || initialPeekError || "new Workpool was not empty before dispatch");
  return;
}

let tgIds;
try {
  tgIds = await tgPool.push(...TG_SPEC.tasks.map((task) => tgPoolPrompt(task)));
} catch (e) {
  const reason = "Workpool.push() failed after dispatch was attempted; tasks were not rerun: " + tgClip(String(e && e.message ? e.message : e), 240);
  const waitState = await tgWaitForPool(tgPool, { cancel: true, waitError: reason });
  const poolResult = tgPoolDecode(undefined, { status: waitState.status, peek: waitState.peek }, waitState);
  const extra = { strategy: "pool", groupError: poolResult.groupError || reason };
  await tgMaybeSummarize(poolResult.outcomes, extra);
  await tgFinalize(poolResult.groupState, extra, poolResult.outcomes);
  return;
}
const tgPushIdsValid =
  Array.isArray(tgIds) &&
  tgIds.length === TG_SPEC.tasks.length &&
  tgIds.every((id) => typeof id === "string" && id.length > 0) &&
  new Set(tgIds).size === TG_SPEC.tasks.length;
if (!tgPushIdsValid) {
  const reason = "Workpool.push() did not return one unique item id per task";
  const waitState = await tgWaitForPool(tgPool, { cancel: true, waitError: reason });
  const poolResult = tgPoolDecode(tgIds, { status: waitState.status, peek: waitState.peek }, waitState);
  const extra = { strategy: "pool", groupError: poolResult.groupError || reason };
  await tgMaybeSummarize(poolResult.outcomes, extra);
  await tgFinalize(poolResult.groupState, extra, poolResult.outcomes);
  return;
}
tgPhase("pool " + TG_GROUP + " created; items pushed: " + tgIds.length);
const tgWaitState = await tgWaitForPool(tgPool);
const tgPoolResult = tgPoolDecode(tgIds, { status: tgWaitState.status, peek: tgWaitState.peek }, tgWaitState);
const TG_EXTRA = {
  strategy: "pool",
  groupState: tgPoolResult.groupState,
  ...(tgPoolResult.groupError !== undefined ? { groupError: tgPoolResult.groupError } : {}),
};
await tgMaybeSummarize(tgPoolResult.outcomes, TG_EXTRA);
await tgFinalize(tgPoolResult.groupState, TG_EXTRA, tgPoolResult.outcomes);
`.trimStart();
}

// ── Two-phase Workpool background ────────────────────────────────────
//
// Phase 1 (dispatch) is one short foreground eval cell: create a named
// Workpool, push every homogeneous task, verify the returned item ids, retain
// the handle plus ids in a kernel global, and return. It never waits.
//
// Phase 2 (collect) is an explicit eval cell the model runs after OMP's native
// async-result notice: status/peek the retained handle, report pending while
// the pool drains, and on a terminal snapshot run the strict item decode, the
// shared Result Gate, and one atomic checksummed result file. It never calls
// wait(), never reads proc://, and never touches another job.

const POOL_INTROSPECTION_HELPERS = `
function tgPoolIsRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function tgPoolIsCount(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
function tgPoolStatusReason(status) {
  if (!tgPoolIsRecord(status) || status.name !== TG_GROUP || typeof status.closed !== "boolean") {
    return "Workpool.status() returned an incompatible status object";
  }
  if (!tgPoolIsRecord(status.items) || !Array.isArray(status.agents) || !tgPoolIsCount(status.batches)) {
    return "Workpool.status() omitted item, agent, or batch state";
  }
  for (const key of ["queued", "running", "completed", "failed", "cancelled"]) {
    if (!tgPoolIsCount(status.items[key])) return "Workpool.status() returned an invalid " + key + " count";
  }
  return undefined;
}
function tgPoolPeekReason(snapshot) {
  if (!tgPoolIsRecord(snapshot) || !Array.isArray(snapshot.batches) || !tgPoolIsCount(snapshot.pending)) {
    return "Workpool.peek() returned an incompatible batch snapshot";
  }
  return undefined;
}
function tgPoolPrompt(task) {
  return "# Your task (" + task.name + ")\\n" + task.task +
    "\\n\\n# Required Task Group result\\n" +
    "After finishing this item, submit exactly one Workpool yield using this item's 1-based batch key. " +
    "Set data to the exact final result as a plain string; do not wrap it in JSON, quotes, or Markdown. " +
    "On failure, use the yield error field with a concise reason. " +
    "Do not put the final result inside a Markdown code fence.";
}
`.trimStart();

const POOL_LIFECYCLE_HELPERS = `
async function tgPoolCloseUnstarted(pool) {
  try { await pool.close(); } catch (e) {}
}
async function tgPoolCancel(pool) {
  let dropped = [];
  let cancelError;
  try {
    const closed = await pool.close();
    if (tgPoolIsRecord(closed) && Array.isArray(closed.dropped)) dropped = closed.dropped.filter((id) => typeof id === "string");
  } catch (e) {
    cancelError = "pool.close() failed: " + tgClip(String(e && e.message ? e.message : e), 200);
  }
  try {
    const result = await tool.write({ path: "proc://" + TG_GROUP + "/kill" });
    const proc = result && result.details && result.details.proc;
    const outcomes = proc && Array.isArray(proc.cancelled) ? proc.cancelled : [];
    const target = outcomes.find((item) => tgPoolIsRecord(item) && item.id === TG_GROUP);
    if (!target || target.status !== "cancelled") {
      cancelError = (cancelError ? cancelError + "; " : "") +
        "proc:// kill did not confirm cancellation" +
        (target && typeof target.status === "string" ? " (" + target.status + ")" : "");
    }
  } catch (e) {
    cancelError = (cancelError ? cancelError + "; " : "") + "proc:// kill failed: " + tgClip(String(e && e.message ? e.message : e), 200);
  }
  return { dropped, cancelError };
}
`.trimStart();

/** Strict snapshot decoder shared by the collect cell (mirrors tgPoolDecode). */
const POOL_BACKGROUND_COLLECT_DECODE = `
function tgBgHasDuplicateJsonKeys(text) {
  let index = 0;
  let duplicate = false;
  function skipSpace() {
    while (text[index] === " " || text[index] === "\\n" || text[index] === "\\r" || text[index] === "\\t") index++;
  }
  function readString() {
    const start = index++;
    let escaped = false;
    while (index < text.length) {
      const ch = text[index++];
      if (escaped) escaped = false;
      else if (ch === "\\\\") escaped = true;
      else if (ch === "\\"") return JSON.parse(text.slice(start, index));
    }
    return "";
  }
  function scanValue() {
    skipSpace();
    const ch = text[index];
    if (ch === "{") {
      index++;
      skipSpace();
      const keys = new Set();
      if (text[index] === "}") { index++; return; }
      while (index < text.length) {
        skipSpace();
        const key = readString();
        if (keys.has(key)) duplicate = true;
        keys.add(key);
        skipSpace();
        index++;
        scanValue();
        skipSpace();
        if (text[index] === ",") { index++; continue; }
        if (text[index] === "}") { index++; return; }
        return;
      }
      return;
    }
    if (ch === "[") {
      index++;
      skipSpace();
      if (text[index] === "]") { index++; return; }
      while (index < text.length) {
        scanValue();
        skipSpace();
        if (text[index] === ",") { index++; continue; }
        if (text[index] === "]") { index++; return; }
        return;
      }
      return;
    }
    if (ch === "\\"") { readString(); return; }
    while (
      index < text.length &&
      text[index] !== " " && text[index] !== "\\n" && text[index] !== "\\r" && text[index] !== "\\t" &&
      text[index] !== "," && text[index] !== "}" && text[index] !== "]"
    ) index++;
  }
  try { scanValue(); } catch (e) { return false; }
  return duplicate;
}
// The two exact wire envelopes a Workpool batch value may encode. Anything
// else is the worker's own JSON text and must stay text, not become structured.
function tgBgIsProtocolEnvelope(value) {
  if (!tgPoolIsRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 1) return typeof value.error === "string";
  return keys.length === 2 &&
    value.status === "succeeded" &&
    Object.prototype.hasOwnProperty.call(value, "value");
}
function tgBgCoversItems(output, batch) {
  const itemIds = batch.items.filter((id) => typeof id === "string");
  const keys = Object.keys(output);
  return keys.length === itemIds.length &&
    itemIds.every((id) => Object.prototype.hasOwnProperty.call(output, id)) &&
    keys.every((id) => itemIds.includes(id));
}
// A failed batch carries its native diagnostic in its output field (the
// worker's error text, or a schema-violation JSON object). The item-envelope
// map is not a diagnostic: the pool already marked every item failed.
function tgBgBatchDiagnostic(batch) {
  if (typeof batch.output !== "string" || batch.output.length === 0) return undefined;
  if (!tgBgHasDuplicateJsonKeys(batch.output)) {
    let parsed;
    try { parsed = JSON.parse(batch.output); }
    catch (e) { parsed = undefined; }
    if (tgPoolIsRecord(parsed)) {
      if (tgBgCoversItems(parsed, batch)) return undefined;
      if (typeof parsed.message === "string" && parsed.message.length > 0) return tgClip(parsed.message, 400);
      if (typeof parsed.error === "string" && parsed.error.length > 0) return tgClip(parsed.error, 400);
    }
  }
  return tgClip(batch.output, 400);
}
function tgBgPoolDecode(ids, status, peek) {
  const issues = [];
  const outcomesByName = new Map();
  const expectedIds = new Set();
  const duplicatePushIds = new Set();
  const assignments = new Map();
  const parsedBatches = new Map();
  const seenBatchIds = new Set();
  if (!Array.isArray(ids) || ids.length !== TG_SPEC.tasks.length || ids.some((id) => typeof id !== "string" || id.length === 0)) {
    issues.push("Workpool.push() did not return exactly one non-empty string id per task");
  } else {
    for (let index = 0; index < ids.length; index++) {
      const id = ids[index];
      if (expectedIds.has(id)) {
        issues.push("Workpool.push() returned duplicate item id " + id);
        duplicatePushIds.add(id);
      }
      expectedIds.add(id);
    }
  }
  const batches = Array.isArray(peek.batches) ? peek.batches : [];
  for (const batch of batches) {
    if (!tgPoolIsRecord(batch) || typeof batch.id !== "string" || typeof batch.agent !== "string" || !Array.isArray(batch.items)) {
      issues.push("Workpool.peek() returned a malformed batch");
      continue;
    }
    if (seenBatchIds.has(batch.id)) issues.push("Workpool.peek() repeated batch id " + batch.id);
    seenBatchIds.add(batch.id);
    if (batch.status !== "completed" && batch.status !== "failed" && batch.status !== "cancelled") {
      issues.push("Workpool batch " + batch.id + " has an unknown status");
    }
    for (const id of batch.items) {
      if (typeof id !== "string" || !expectedIds.has(id)) {
        issues.push("Workpool batch " + batch.id + " contained an unknown item id");
        continue;
      }
      if (assignments.has(id)) {
        issues.push("Workpool item " + id + " appeared in more than one batch");
        assignments.set(id, { duplicate: true, batch });
      } else {
        assignments.set(id, { batch });
      }
    }
    if (batch.status !== "completed") {
      // A terminal failed/cancelled batch is a legitimate group outcome, not
      // a protocol failure. Its items are mapped to failed/cancelled below;
      // a failed batch keeps its bounded native diagnostic for the gate.
      const diagnostic = batch.status === "failed" ? tgBgBatchDiagnostic(batch) : undefined;
      parsedBatches.set(batch.id, { terminal: batch.status, diagnostic: diagnostic });
      continue;
    }
    if (typeof batch.output !== "string") {
      parsedBatches.set(batch.id, { error: "Workpool batch output is missing" });
      continue;
    }
    if (tgBgHasDuplicateJsonKeys(batch.output)) {
      parsedBatches.set(batch.id, { error: "Workpool batch output contains duplicate JSON object keys" });
      continue;
    }
    let output;
    try { output = JSON.parse(batch.output); }
    catch (e) {
      parsedBatches.set(batch.id, { error: "Workpool batch output is invalid or truncated JSON" });
      continue;
    }
    if (!tgPoolIsRecord(output)) {
      parsedBatches.set(batch.id, { error: "Workpool batch output is not a JSON object" });
      continue;
    }
    if (!tgBgCoversItems(output, batch)) {
      parsedBatches.set(batch.id, { error: "Workpool batch output did not cover exactly its declared item ids" });
      continue;
    }
    parsedBatches.set(batch.id, { output });
  }
  for (const [batchId, decoded] of parsedBatches) {
    if (decoded.error) issues.push("Workpool batch " + batchId + ": " + decoded.error);
  }
  const outcomes = [];
  for (let index = 0; index < TG_SPEC.tasks.length; index++) {
    const task = TG_SPEC.tasks[index];
    const id = Array.isArray(ids) ? ids[index] : undefined;
    let outcome;
    if (typeof id !== "string" || id.length === 0) {
      outcome = { name: task.name, agent: task.agent, status: "failed", error: "Workpool item id is unavailable" };
    } else if (duplicatePushIds.has(id)) {
      outcome = { name: task.name, agent: task.agent, status: "failed", error: "Workpool.push() duplicated item id " + id };
    } else {
      const assignment = assignments.get(id);
      const batch = assignment && assignment.batch;
      const decoded = batch && parsedBatches.get(batch.id);
      if (!assignment) {
        issues.push("Workpool.peek() omitted item " + id);
        outcome = { name: task.name, agent: task.agent, status: "failed", error: "Workpool.peek() omitted item " + id };
      } else if (assignment.duplicate) {
        outcome = { name: task.name, agent: task.agent, status: "failed", error: "Workpool.peek() duplicated item " + id };
      } else if (batch.status === "cancelled") {
        outcome = { name: task.name, agent: task.agent, status: "cancelled", error: "Workpool batch was cancelled", handle: "agent://" + batch.agent };
      } else if (batch.status === "failed") {
        outcome = {
          name: task.name,
          agent: task.agent,
          status: "failed",
          error: decoded && decoded.diagnostic ? decoded.diagnostic : "Workpool worker batch failed",
          handle: "agent://" + batch.agent,
        };
      } else if (!decoded || decoded.error || !tgPoolIsRecord(decoded.output)) {
        outcome = {
          name: task.name,
          agent: task.agent,
          status: "failed",
          error: decoded && decoded.error ? decoded.error : "Workpool batch result could not be verified",
          handle: typeof batch.agent === "string" ? "agent://" + batch.agent : undefined,
        };
      } else {
        let envelope = decoded.output[id];
        if (typeof envelope === "string") {
          try {
            if (!tgBgHasDuplicateJsonKeys(envelope)) {
              const parsedEnvelope = JSON.parse(envelope);
              // Only the exact protocol envelopes are unwrapped; any other
              // JSON-object text is the worker's literal result and stays text.
              if (tgBgIsProtocolEnvelope(parsedEnvelope)) envelope = parsedEnvelope;
            }
          } catch (e) {}
        }
        if (
          tgPoolIsRecord(envelope) &&
          envelope.status === "succeeded" &&
          Object.prototype.hasOwnProperty.call(envelope, "value") &&
          Object.keys(envelope).length === 2
        ) {
          outcome = { name: task.name, agent: task.agent, status: "succeeded", handle: "agent://" + batch.agent };
          tgStoreResult(outcome, envelope.value);
        } else if (
          tgPoolIsRecord(envelope) &&
          typeof envelope.error === "string" &&
          Object.keys(envelope).length === 1
        ) {
          outcome = {
            name: task.name,
            agent: task.agent,
            status: "failed",
            error: tgClip(envelope.error, 400),
            handle: "agent://" + batch.agent,
          };
        } else if (envelope !== undefined) {
          // Apart from the reserved one-field {error} failure envelope, any
          // defined Workpool yield is task data and must be preserved verbatim.
          outcome = { name: task.name, agent: task.agent, status: "succeeded", handle: "agent://" + batch.agent };
          tgStoreResult(outcome, envelope);
        } else {
          outcome = {
            name: task.name,
            agent: task.agent,
            status: "failed",
            error: "Workpool item " + id + " returned no result envelope",
            handle: "agent://" + batch.agent,
          };
        }
      }
    }
    outcomes.push(outcome);
  }
  const itemCounts = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const outcome of outcomes) {
    const state = outcome.status === "succeeded" ? "completed" : outcome.status;
    if (itemCounts[state] !== undefined) itemCounts[state]++;
  }
  if (!tgPoolIsRecord(status) || !tgPoolIsRecord(status.items)) {
    issues.push("Workpool.status() item counts are missing");
  } else {
    // A completed Workpool item may yield a logical error envelope. Workpool
    // counts that item as completed while the decoded outcome is failed, so
    // requiring per-status equality would reject legitimate partial failures.
    const terminalCount = status.items.completed + status.items.failed + status.items.cancelled;
    if (terminalCount !== outcomes.length) {
      issues.push("Workpool terminal item counts do not cover the task set");
    }
    if (status.items.cancelled !== itemCounts.cancelled) {
      issues.push("Workpool status cancelled count disagrees with item results");
    }
    if (status.items.failed > itemCounts.failed) {
      issues.push("Workpool status failed count exceeds item results");
    }
    if (status.items.queued !== 0 || status.items.running !== 0) {
      issues.push("Workpool still reports queued or running items");
    }
  }
  if (!tgPoolIsRecord(peek) || peek.pending !== 0) {
    issues.push("Workpool.peek() still reports pending items");
  }
  if (
    tgPoolIsRecord(status) &&
    tgPoolIsRecord(peek) &&
    Array.isArray(peek.batches) &&
    status.batches !== peek.batches.length
  ) {
    issues.push("Workpool status batch count disagrees with peek()");
  }
  const succeeded = outcomes.filter((outcome) => outcome.status === "succeeded").length;
  const cancelled = outcomes.filter((outcome) => outcome.status === "cancelled").length;
  const groupState =
    issues.length > 0 ? "failed" :
    succeeded > 0 ? "completed" :
    cancelled === outcomes.length ? "cancelled" : "failed";
  return { outcomes, issues, groupState };
}
`.trimStart();

/**
 * Compile the background dispatch cell. The program returns a single JSON view
 * after the pool item ids are verified; if that view is missing, the host does
 * not treat the dispatch as successful.
 */
export function compilePoolBackgroundDispatchProgram(
  spec: TaskGroupSpec,
  opts: CompileOptions,
): string {
  if (opts.background === undefined) {
    throw new Error("internal error: background dispatch options are missing");
  }
  return `
${sharedPrelude(spec, { ...opts, collect: undefined })}
const TG_BG_DISPATCH = ${JSON.stringify(opts.background)};
const TG_BG_REGISTRY_KEY = ${JSON.stringify(POOL_BACKGROUND_REGISTRY)};
const TG_BG_TRANSPORT = ${JSON.stringify(POOL_BACKGROUND_DISPATCH_TRANSPORT)};
${POOL_INTROSPECTION_HELPERS}
${POOL_LIFECYCLE_HELPERS}

function tgBgAdmissionReason() {
  if (!Array.isArray(TG_SPEC.tasks) || TG_SPEC.tasks.length === 0) {
    return "background requires at least one task";
  }
  if (TG_SPEC.join.mode !== "all" || TG_SPEC.failure.mode !== "collect") {
    return "background requires join=all and failure=collect";
  }
  if (TG_SPEC.execution.concurrency !== "auto") {
    return "background requires execution.concurrency=auto";
  }
  if (TG_SPEC.output.mode === "summarize") {
    return "background cannot run a summarizer; use compact or structured output";
  }
  const first = TG_SPEC.tasks[0];
  for (const task of TG_SPEC.tasks) {
    if (task.schema !== undefined) return "background cannot preserve per-task output schemas";
    if (task.isolated === true) return "background cannot preserve per-task worktree isolation";
    if (task.agent !== first.agent) return "background requires every task to use the same agent";
    if (JSON.stringify(task.tools || []) !== JSON.stringify(first.tools || [])) {
      return "background requires identical per-task tool sets";
    }
  }
  return undefined;
}
function tgBgRegistry() {
  const key = TG_BG_REGISTRY_KEY;
  let registry = globalThis[key];
  if (registry === undefined || registry === null) {
    registry = { version: 1, groups: new Map() };
    globalThis[key] = registry;
  }
  if (!tgPoolIsRecord(registry) || registry.version !== 1 || !(registry.groups instanceof Map)) {
    return undefined;
  }
  return registry;
}
function tgBgEmit(payload) {
  console.log({
    protocol: TG_PROTOCOL,
    transport: TG_BG_TRANSPORT,
    groupId: TG_GROUP,
    resultId: TG_BG_DISPATCH.resultId,
    ...payload,
  });
}
function tgBgFailure(stage, reason, extra) {
  tgBgEmit({ state: "failed", stage: stage, reason: tgClip(reason, 800), dispatched: false, ...(extra || {}) });
}
async function tgBgDispatch() {
  const admission = tgBgAdmissionReason();
  if (admission !== undefined) {
    tgBgFailure("admission", admission);
    return;
  }
  if (typeof workpool !== "function") {
    tgBgFailure("capability", "native Eval does not expose workpool()");
    return;
  }
  const registry = tgBgRegistry();
  if (registry === undefined) {
    tgBgFailure("registry", "the eval-kernel background registry has an incompatible shape");
    return;
  }
  if (registry.groups.has(TG_GROUP)) {
    tgBgFailure("registry", "a Workpool handle is already registered for this group id");
    return;
  }
  const firstTask = TG_SPEC.tasks[0];
  const poolOptions = { name: TG_GROUP, context: TG_SPEC.context };
  if (Array.isArray(firstTask.tools) && firstTask.tools.length > 0) poolOptions.tools = firstTask.tools;
  let pool;
  try {
    pool = await workpool(firstTask.agent, poolOptions);
  } catch (e) {
    tgBgFailure("create", "workpool() failed before dispatch: " + tgClip(String(e && e.message ? e.message : e), 300));
    return;
  }
  if (
    !pool ||
    typeof pool.push !== "function" ||
    typeof pool.status !== "function" ||
    typeof pool.peek !== "function" ||
    typeof pool.close !== "function"
  ) {
    await tgPoolCloseUnstarted(pool);
    tgBgFailure("create", "the workpool object lacks the documented push/status/peek/close methods");
    return;
  }
  let initialStatus;
  let initialPeek;
  try {
    initialStatus = await pool.status();
    initialPeek = await pool.peek();
  } catch (e) {
    await tgPoolCloseUnstarted(pool);
    tgBgFailure("create", "workpool status/peek preflight failed before dispatch: " + tgClip(String(e && e.message ? e.message : e), 300));
    return;
  }
  const initialStatusError = tgPoolStatusReason(initialStatus);
  const initialPeekError = tgPoolPeekReason(initialPeek);
  if (
    initialStatusError ||
    initialPeekError ||
    initialStatus.closed !== false ||
    initialStatus.batches !== 0 ||
    initialPeek.pending !== 0 ||
    initialPeek.batches.length !== 0 ||
    ["queued", "running", "completed", "failed", "cancelled"].some((key) => initialStatus.items[key] !== 0)
  ) {
    await tgPoolCloseUnstarted(pool);
    tgBgFailure("create", initialStatusError || initialPeekError || "the new Workpool was not empty before dispatch");
    return;
  }
  let ids;
  try {
    ids = await pool.push(...TG_SPEC.tasks.map(tgPoolPrompt));
  } catch (e) {
    const cancellation = await tgPoolCancel(pool);
    tgBgFailure(
      "push",
      "Workpool.push() failed after dispatch was attempted; tasks were not rerun: " + tgClip(String(e && e.message ? e.message : e), 300),
      {
        dispatched: true,
        cancelled: cancellation.cancelError === undefined,
        ...(cancellation.cancelError !== undefined ? { cancelError: cancellation.cancelError } : {}),
      },
    );
    return;
  }
  const idsValid =
    Array.isArray(ids) &&
    ids.length === TG_SPEC.tasks.length &&
    ids.every((id) => typeof id === "string" && id.length > 0) &&
    new Set(ids).size === ids.length;
  if (!idsValid) {
    const cancellation = await tgPoolCancel(pool);
    tgBgFailure(
      "push",
      "Workpool.push() did not return one unique item id per task; tasks were not rerun",
      {
        dispatched: true,
        cancelled: cancellation.cancelError === undefined,
        ...(cancellation.cancelError !== undefined ? { cancelError: cancellation.cancelError } : {}),
      },
    );
    return;
  }
  try {
    registry.groups.set(TG_GROUP, {
      version: 1,
      groupId: TG_GROUP,
      resultId: TG_BG_DISPATCH.resultId,
      pool,
      ids: ids.slice(),
      taskNames: TG_SPEC.tasks.map((task) => task.name),
      dispatchedAtMs: Date.now(),
    });
  } catch (e) {
    const cancellation = await tgPoolCancel(pool);
    tgBgFailure(
      "registry",
      "could not retain the Workpool handle after dispatch; tasks were not rerun: " + tgClip(String(e && e.message ? e.message : e), 300),
      {
        dispatched: true,
        cancelled: cancellation.cancelError === undefined,
        ...(cancellation.cancelError !== undefined ? { cancelError: cancellation.cancelError } : {}),
      },
    );
    return;
  }
  tgPhase("background pool " + TG_GROUP + " dispatched: " + ids.length + " item(s)");
  tgBgEmit({
    state: "dispatched",
    poolName: TG_GROUP,
    itemIds: ids.slice(),
    taskCount: ids.length,
    taskNames: TG_SPEC.tasks.map((task) => task.name),
  });
}
await tgBgDispatch();
`.trimStart();
}

/**
 * Compile the explicit collect cell for one background group. It keeps the
 * retained pool handle (only status/peek), reports pending while the pool is
 * not drained, and writes the result file exactly once per terminal snapshot.
 */
export function compilePoolBackgroundCollectProgram(
  spec: TaskGroupSpec,
  opts: CompileOptions,
): string {
  if (opts.collect === undefined) {
    throw new Error("internal error: collect options are missing");
  }
  return `
${sharedPrelude(spec, opts)}
${RESULT_GATE_SOURCE}
const TG_BG_REGISTRY_KEY = ${JSON.stringify(POOL_BACKGROUND_REGISTRY)};
const TG_BG_TRANSPORT = ${JSON.stringify(POOL_BACKGROUND_COLLECT_TRANSPORT)};
${POOL_INTROSPECTION_HELPERS}
${POOL_BACKGROUND_COLLECT_DECODE}
${resultHelpers(true)}

function tgBgOutcomeCounts(outcomes) {
  const counts = { succeeded: 0, failed: 0, cancelled: 0 };
  for (const outcome of outcomes) {
    const status = outcome && outcome.status;
    if (counts[status] !== undefined) counts[status]++;
  }
  return counts;
}
function tgBgPoolFacts(status, peek) {
  return {
    queued: status.items.queued,
    running: status.items.running,
    completed: status.items.completed,
    failed: status.items.failed,
    cancelled: status.items.cancelled,
    closed: status.closed,
    pending: peek.pending,
    batches: Array.isArray(peek.batches) ? peek.batches.length : 0,
  };
}
function tgBgCollectEmit(payload) {
  console.log({
    protocol: TG_PROTOCOL,
    transport: TG_BG_TRANSPORT,
    groupId: TG_GROUP,
    resultId: TG_BG_RESULT.resultId,
    ...payload,
  });
}
function tgBgPendingReason(status, peek) {
  if (status.items.queued !== 0 || status.items.running !== 0) {
    return "Workpool items are still queued or running";
  }
  if (peek.pending !== 0) return "Workpool.peek() still reports pending items";
  for (const batch of peek.batches) {
    if (!tgPoolIsRecord(batch) || typeof batch.status !== "string") return "Workpool.peek() returned a malformed batch";
    if (batch.status !== "completed" && batch.status !== "failed" && batch.status !== "cancelled") {
      return "Workpool batch " + String(batch.id) + " is still " + batch.status;
    }
  }
  return undefined;
}
function tgBgHandleFailure(stage, reason) {
  tgBgCollectEmit({ state: "failed", stage: stage, reason: reason });
}
async function tgBgCollect() {
  const registry = globalThis[TG_BG_REGISTRY_KEY];
  if (!tgPoolIsRecord(registry) || registry.version !== 1 || !(registry.groups instanceof Map)) {
    tgBgHandleFailure(
      "handle",
      "the retained Workpool registry is unavailable (eval kernel reset, a different session, or the dispatch cell never ran). The pooled work may still be running; do not re-dispatch.",
    );
    return;
  }
  const entry = registry.groups.get(TG_GROUP);
  if (
    !tgPoolIsRecord(entry) ||
    entry.groupId !== TG_GROUP ||
    entry.resultId !== TG_BG_RESULT.resultId
  ) {
    tgBgHandleFailure(
      "handle",
      "no retained Workpool handle matches this group and result id in the current eval kernel; do not re-dispatch.",
    );
    return;
  }
  if (
    !Array.isArray(entry.ids) ||
    entry.ids.length !== TG_SPEC.tasks.length ||
    entry.ids.some((id) => typeof id !== "string" || id.length === 0) ||
    new Set(entry.ids).size !== entry.ids.length ||
    (Array.isArray(entry.taskNames) &&
      (entry.taskNames.length !== TG_SPEC.tasks.length ||
        entry.taskNames.some((name, index) => name !== TG_SPEC.tasks[index].name)))
  ) {
    tgBgHandleFailure("handle", "the retained Workpool item ids do not match this group's tasks; refusing to collect.");
    return;
  }
  if (
    !tgPoolIsRecord(entry.pool) ||
    typeof entry.pool.status !== "function" ||
    typeof entry.pool.peek !== "function"
  ) {
    tgBgHandleFailure("handle", "the retained Workpool handle lacks status()/peek(); refusing to collect.");
    return;
  }
  let status;
  let peek;
  try {
    status = await entry.pool.status();
    peek = await entry.pool.peek();
  } catch (e) {
    tgBgHandleFailure("state", "Workpool status/peek failed: " + tgClip(String(e && e.message ? e.message : e), 400));
    return;
  }
  const statusError = tgPoolStatusReason(status);
  const peekError = tgPoolPeekReason(peek);
  if (statusError || peekError) {
    tgBgHandleFailure("state", statusError || peekError);
    return;
  }
  const pendingReason = tgBgPendingReason(status, peek);
  if (pendingReason !== undefined) {
    tgBgCollectEmit({
      state: "pending",
      reason: pendingReason,
      counts: {
        succeeded: status.items.completed,
        failed: status.items.failed,
        cancelled: status.items.cancelled,
      },
      pool: tgBgPoolFacts(status, peek),
    });
    return;
  }
  const decoded = tgBgPoolDecode(entry.ids, status, peek);
  if (decoded.issues.length > 0) {
    tgBgCollectEmit({
      state: "failed",
      stage: "decode",
      reason: tgClip(decoded.issues.join("; "), 1600),
      counts: tgBgOutcomeCounts(decoded.outcomes),
      pool: tgBgPoolFacts(status, peek),
    });
    return;
  }
  const groupState = decoded.groupState;
  const extra = { strategy: "pool", groupState: groupState };
  const written = await tgFinalize(groupState, extra, decoded.outcomes);
  if (!written || written.ok !== true) {
    tgBgCollectEmit({
      state: "failed",
      stage: "write",
      reason: (written && written.error) ? written.error : "the checksummed result file could not be written",
      counts: tgBgOutcomeCounts(decoded.outcomes),
      pool: tgBgPoolFacts(status, peek),
    });
    return;
  }
  tgPhase("background pool " + TG_GROUP + " collected: " + groupState);
  tgBgCollectEmit({
    state: "ready",
    groupState: groupState,
    counts: tgBgOutcomeCounts(decoded.outcomes),
    pool: tgBgPoolFacts(status, peek),
    path: TG_BG_RESULT.path,
    checksum: written.checksum,
    payloadChars: written.payloadChars,
  });
}
await tgBgCollect();
`.trimStart();
}
