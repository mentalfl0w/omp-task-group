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
 * output.perTaskChars before it enters the wire payload.
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

export interface CompileOptions {
  groupId: string;
  summarize?: { model: "smol" | "default" | "slow" } | undefined;
  /** Wall-clock guard marker for runaway groups (ms). */
  maxGroupMs?: number;
  /** Reason an otherwise eligible Pool plan was downgraded before dispatch. */
  fallbackReason?: string | undefined;
}

/** Stable wire payload protocol shared by compiler and result decoder. */
export const EVAL_RESULT_PROTOCOL = "omp-task-group/eval-result-v1";
/** Identifies result chunks carried as OMP eval JSON views. */
export const EVAL_RESULT_TRANSPORT = "omp-task-group/eval-result-view-v1";
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
const RESULT_HELPERS = `
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
function tgFinalize(groupState, extra, outcomes) {
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
`.trimStart();

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
tgFinalize(tgGroupState, TG_EXTRA, tgFinalRows);
`.trimStart();

export function compileFanoutProgram(spec: TaskGroupSpec, opts: CompileOptions): string {
  return `
${sharedPrelude(spec, opts)}
${WAIT_REGISTRY}
${RESULT_HELPERS}
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
${RESULT_HELPERS}
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
    "On success, set data to {status: \\"succeeded\\", value: <your exact result>}. " +
    "On failure, use the yield error field with a concise reason. " +
    "Do not put the success envelope inside a Markdown code fence.";
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
      parsedBatches.set(batch.id, { error: "Workpool batch status was " + batch.status });
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
    const itemIds = batch.items.filter((id) => typeof id === "string");
    const keys = Object.keys(output);
    if (
      keys.length !== itemIds.length ||
      itemIds.some((id) => !Object.prototype.hasOwnProperty.call(output, id)) ||
      keys.some((id) => !itemIds.includes(id))
    ) {
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
          error: decoded && decoded.error ? decoded.error : "Workpool worker batch failed",
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
              if (tgPoolIsRecord(parsedEnvelope)) envelope = parsedEnvelope;
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
        } else {
          const preview = JSON.stringify(envelope);
          outcome = {
            name: task.name,
            agent: task.agent,
            status: "failed",
            error: "Workpool item " + id + " has an invalid result envelope: " + tgClip(preview === undefined ? String(envelope) : preview, 200),
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
    for (const key of ["queued", "running", "completed", "failed", "cancelled"]) {
      if (snapshot.status.items[key] !== itemCounts[key]) {
        issues.push("Workpool status count for " + key + " disagrees with item results");
      }
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
  const groupState =
    waitState.interrupted ? "cancelled" :
    waitState.timedOut ? "failed" :
    waitState.terminalStatus === "cancelled" ? "cancelled" :
    uniqueIssues.length > 0 ? "failed" :
    succeeded > 0 ? "completed" : "failed";
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
  tgFinalize(poolResult.groupState, extra, poolResult.outcomes);
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
  tgFinalize(poolResult.groupState, extra, poolResult.outcomes);
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
tgFinalize(tgPoolResult.groupState, TG_EXTRA, tgPoolResult.outcomes);
`.trimStart();
}
