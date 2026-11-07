# omp-task-group

**Atomic multi-agent coordination for [Oh My Pi (OMP)](https://omp.sh)** — fan out N
independent subagents, join, and return **exactly one logical result** to the parent.
Not a workflow engine: no DAG, no `depends_on`, no pipeline, no loop, no resume.

Targets OMP's documented Eval API audited against v18.16.0. Zero runtime dependencies; public API only.

**Background Workpool is Beta:** it requires an explicit Collect after the native
completion notice. The notice is an ungated preview, not the final result.
Kernel reset or a session switch before Collect can make the retained handle or
registration unavailable; do not re-dispatch tasks to recover it.

## What it does

When you delegate 2+ **independent** jobs whose **combined** results drive your next
decision, the naive `task`-per-job pattern amplifies parent wakes: every child
completion is a separate async delivery that interrupts you. Task Group's default
foreground path fixes that (explicit background opt-in is separate):

| Property | Without (N × task) | With Task Group |
| --- | --- | --- |
| Logical parent deliveries | N | **1** |
| Wake amplification | N | **1/N** |
| Parent context cost | N raw child outputs | **one bounded digest** |
| Failure handling | ad hoc | `all / any / quorum` × `collect / fail_fast` |

```
Main: 1 call → [child1 child2 … childN] (parallel) → 1 joined result back
```

## Install

```bash
# clone somewhere stable
cd ~/src && git clone <this-repo> omp-task-group && cd omp-task-group
bun install && bun run build
omp plugin link "$(pwd)"
```

The plugin does **not** shadow or re-register the built-in `eval` tool. A Task
Group runs as an ordinary native eval cell whose code is exactly one
`ompTaskGroup(<strict JSON>)` envelope; the plugin recognizes the envelope through
tool hooks, runs the group inside that single cell, and returns **one joined
result**. Ordinary eval is never claimed as plugin-owned — non-envelope cells run
exactly as native eval would.

## Usage

Single delegated job → keep using the native async `task` tool. Dependent stages,
pipelines, loops, resume → use OMP **swarm**. Task Group is for **one atomic batch**:

```js
ompTaskGroup({
  "context": "Audit plan: independent workstreams, results are combined.",
  "label": "audit",
  "background": "auto",
  "tasks": [
    { "name": "deps",  "agent": "scout",  "task": "Enumerate vulnerable dependencies." },
    { "name": "auth",  "agent": "security-reviewer", "task": "Review auth flows." },
    { "name": "tests", "agent": "scout",  "task": "Report test coverage gaps." }
  ],
  "join":     { "mode": "all" },
  "failure":  { "mode": "collect" },
  "execution": { "strategy": "auto", "concurrency": "auto", "mode": "auto" },
  "output":   { "mode": "compact", "perTaskChars": 1200, "maxTotalChars": 8000 }
});
```

That block is the **entire cell**: a standard `eval` call with `language: "js"`,
`timeout: 0`, and `code` containing exactly the `ompTaskGroup(...)` envelope —
outer whitespace and one optional terminal semicolon are allowed, nothing else is.
The argument is strict JSON (double-quoted keys, no comments, no trailing commas),
so the envelope is recognized without executing arbitrary JavaScript. A
recognized-but-malformed envelope is blocked with a precise reason; anything that
is not the envelope is an ordinary eval cell and runs exactly as native eval would.

Per task: `schema` (+ `schemaMode`) for structured output, `isolated` for worktree
isolation, `tools` for kernel-tool exposure, `effort` (forward-compatible).

`background`: `auto` (default) or `foreground` execute one foreground Eval cell.
`require` is the **explicit two-phase Workpool background opt-in**: a short
dispatch cell creates a native Workpool, pushes every task, and returns the
verified item ids; after OMP's own async-result notice, an explicit
`ompTaskGroupCollect({"groupId","resultId"})` cell checks the retained handle and
writes one atomic, SHA-256-checked private result file. Read that file with the
`task_group_result` tool in bounded segments and delete it with `consume`.

`execution.mode`: `auto` (default) or `foreground` — the same foreground policy.
An explicit `execution.mode: "background"` is the same two-phase opt-in as
`background: "require"`. Combining an explicit foreground value with an explicit
background value is a validation error. Background is never inferred from
configuration, and it does **not** depend on OMP's `eval.autoBackground`
setting.

### Join and failure

- `join.mode`: `all` (default) · `any` (first success settles) · `quorum: N`
- `failure.mode`: `collect` (default — report everything, group completes with
  partial successes) · `fail_fast` (first failure cancels the rest)
- Losers of `any`/`quorum`/`fail_fast` are **cancelled and reaped** — their
  deliveries are consumed, nothing leaks to the parent.

### Output modes (Result Gate)

- `compact` — join state/counts, per-task glyph/status, failure preview, clipped
  (or omitted when no budget remains) body preview, and `agent://` handles.
  Fanout records local per-task duration. The current public Eval API does not
  expose a resolved model per AgentHandle; Workpool also omits per-item duration,
  so those fields are not fabricated.
- `structured` — one valid JSON aggregate of per-task outputs. When large child
  values would exceed `maxTotalChars`, they are replaced by
  `{"$truncated": <original JSON chars>}` markers (or counted in a top-level
  `omittedResults` field when even markers cannot fit); task names, statuses,
  failure errors, handles, and the group/join outcome stay in the document.
- `summarize` — stateless `completion()` digest (opt-in via config), falls back to
  compact on failure. The digest is the only part clipped by total budget.
- Hard caps: `perTaskChars` per task, `maxTotalChars` total. Raw child output is
  **never** concatenated wholesale. Mandatory metadata — every task status,
  failure preview, join result/group error, and every requested handle — is laid
  out before body previews and is never hidden by total-length clipping. Text
  clipping never splits a UTF-16 surrogate pair.
- If `maxTotalChars` is too small for that mandatory metadata, the gate fails
  explicitly (`gateError` in details, `isError: true`) and delivers a bounded
  failure notice instead of a truncated result that looks complete.

### Strategies

- `fanout` — per-child agents with per-handle waits, all inside the single eval
  cell; each handle result is consumed exactly once, so the parent sees one
  native eval result.
- `pool` — one Workpool for large homogeneous `all + collect` batches. The compiler uses
  `workpool(agent, { name, context, tools })`, `pool.status()`, `pool.peek()`,
  and the ordinary `tool.wait()` tool; it does not use kernel `wait(handles)`
  or poll for completion. Every pushed item needs one unique returned ID and
  one matching key in the batch JSON output; duplicate JSON keys, missing or
  malformed results, pending items, and status-count mismatches fail closed.
  A JSON-string-encoded envelope is decoded only when it parses to the exact
  success/failure shape; markdown fences are never stripped or guessed.
- Pool is ineligible for per-task schemas, isolation, or explicit per-group
  concurrency. Runtime preflight falls back to Fanout before submission if the
  public result/wait contract is unavailable or another caller-owned job or
  live agent could win `wait()`. Existing services may produce intermediate
  snapshots while a Pool job is active; they do not disable Pool.
- Non-builtin Eval wrappers permit Pool only when every wrapper's public
  `ToolInfo.description` contains `omp-task-group-pool-proc-cancel:v1`.
  An unmarked wrapper or unavailable ToolInfo forces pre-dispatch Fanout;
  `/task-group explain` records the reason. Once `push()` is attempted, errors
  are canceled and reaped; tasks are never rerun.
- `auto` (default) picks between them; `/task-group explain` shows static and
  runtime fallback reasons. The capability report marks Workpool and Task Group
  Pool as conditional until the active Eval runtime passes its preflight.

## Commands

- `/task-group` — overview + capability probe
- `/task-group stats` — cumulative telemetry (wake amplification, output reduction, strategy mix)
- `/task-group explain` — why the last group chose its strategy
- `/task-group config` — effective configuration
- `/task-group background` — two-phase Workpool background requirements plus the foreground `eval.autoBackground` scan

## Smart Dispatcher (default: `suggest`)

A short routing policy is appended to the system prompt (zero extra inference) via
`before_agent_start`. `enforce` mode additionally blocks obviously-batched native
`task` calls. `off` disables both. The post-hoc Missed Group Detector records
`missed_group_candidates` telemetry when ≥2 independent `task` calls happen in one turn.

## Configuration

`~/.omp/agent/task-group.json` and/or `<cwd>/.omp/task-group.json` (project wins).
Unknown keys ignored; invalid values error with a precise path.

```json
{
  "enabled": true,
  "dispatcher": { "mode": "suggest", "detectMissedGroups": true },
  "execution": { "strategy": "auto", "concurrency": "auto", "pool": { "enabled": "auto", "threshold": 6 } },
  "join": { "default": "all" },
  "failure": { "default": "collect" },
  "output": { "mode": "compact", "perTaskChars": 1200, "maxTotalChars": 8000, "preserveHandles": true },
  "summarize": { "enabled": false, "model": "smol" },
  "telemetry": { "enabled": true, "detectMissedGroups": true },
  "background": { "retentionMinutes": 30 }
}
```

There is no task-group background switch. `background.retentionMinutes`
(integer 1–1440, default 30) only bounds how long an observed, unconsumed
background result file stays readable for the group that registered it; it
never enables background execution. Each group resolves this key from its own
cwd config, so project overlays keep independent retention windows; the
two-hour pending deadline is unchanged. Background admission never reads OMP's
`eval.autoBackground` setting.

### Background execution (two-phase Workpool)

Foreground groups (`auto` / `foreground`) require `eval.autoBackground` to be
disabled; if the host still backgrounds the cell, the foreground `tool_result`
sees `details.async` and fails closed with an explicit diagnosis. That scan is
only foreground protection.

Background is an explicit opt-in (`background: "require"` or
`execution.mode: "background"`) and is accepted only for a real Workpool plan:
homogeneous `join=all` + `failure=collect` tasks, `execution.concurrency="auto"`,
no per-task schema/isolation, `output.mode` compact or structured, and pool not
disabled by config. The numeric pool threshold is not applied to an explicit
background opt-in. Anything else is blocked before execution with the plan
reason; there is no Fanout fallback.

**Phase 1 — dispatch.** One short eval cell creates
`workpool(agent, {name: groupId, context, tools})`, pushes every task, verifies
that `push()` returned exactly one unique item id per task, retains the handle
plus ids in the shared eval kernel, and returns. It never calls `wait()`, never
starts a detached promise, and sends no plugin notification. Success is
confirmed only by the cell receipt carrying those verified ids;
`details.async` is never treated as success. A failed or unconfirmed dispatch
reports an error and does not rerun tasks.

**Native notice — not the result.** OMP delivers its own async-result notice
when the pool settles. Its preview can contain raw, ungated aggregate child
text and may be truncated; it is informational only and never a Task Group
result.

This is not one bounded end-to-end delivery: the raw notice and the later
collect/read/consume calls add context and tool turns. It does not reduce
parent wakeups or context cost compared with a foreground Task Group. For one
measured three-task run, the native notice was 1,274 characters / 519
`o200k_base` tokens and the separate gated-read response was 628 characters /
261 tokens, including its receipt. These are sample counts, not a universal
limit or provider usage. See [background delivery](docs/BACKGROUND.md).

**Phase 2 — explicit collect.** After the notice, the assistant runs one more eval cell without asking the user to enter it:

```
ompTaskGroupCollect({"groupId":"tg…","resultId":"tgbg_…"})
```

The collect cell reads only the retained handle's `status()`/`peek()`. While the
pool is draining it returns `state="pending"` and never waits or consumes
another job. On a drained snapshot it strictly decodes every item/batch (exact
coverage, no duplicate ids or JSON keys, status/count agreement), runs the
**shared Result Gate core**, and stores the bounded payload through the
write-approved `task_group_store_result` tool. That tool accepts no path and
writes only the registered group's own file after validating identity,
protocol, deterministic gate text, and size; a denied or failed write reports
`stage="write"` with no ready file. Real Smart Approve 2.7.2 tests passed in
both extension load orders; a headless approval prompt denial failed closed
without a file. A kernel reset loses the retained handle;
a session switch clears the result registration. Collect reports an explicit
error rather than inventing a result or rerunning tasks.

OMP applies its native tool approval policy to the `approval: "write"` store
tool, including calls made through the Eval tool bridge. Smart Approve's Eval
static analysis does not inspect the store tool's internal filesystem paths;
path restrictions and ownership checks are enforced by Task Group itself.

The result file is atomic and private:

- session-private directory under the OS temp root: `omp-task-group-results-*`,
  mode `0700`;
- file `<groupId>.json`, mode `0600`, atomic temp + rename;
- wrapper `{ format, protocol, groupId, resultId, createdAtMs, payloadChars, sha256, payloadJson }`;
  SHA-256 over the exact UTF-8 payload JSON.

Read it with `task_group_result`:

```json
{ "action": "read", "id": "tgbg_…" }
{ "action": "status", "id": "tgbg_…" }
{ "action": "consume", "id": "tgbg_…" }
```

`read` verifies the wrapper, identity, ownership/mode, size, SHA-256, and the
exact-coverage payload decoder, then serves the in-cell gated text in
4000-character segments. Repeat `read` without `offset` until `complete=true`;
`consume` then deletes only that registered file. Repeating `consume` returns a
non-error already-consumed receipt, deletes nothing again, and re-delivers no
content; an id never consumed in the session stays a not-found error. Receipts
hold no payload text and are capped at the most recent 256 per session.
`status` reports `pending` / `ready` / `materialized` plus TTL and the record's
configured retention. Pending means “collect has not written a file yet”; it is
never success. Integrity failures, wrong ids, foreign ownership, non-private
modes, symlinks, and model-supplied paths fail closed.

An observed, unconsumed result file has a configurable TTL:
`background.retentionMinutes` (default 30 minutes, range 1–1440), recorded with
the group and renewed by access or delivery progress while still unexpired. A
partially delivered result is never expired; an access after the deadline
reclaims rather than revives it. A group with no file yet uses a fixed two-hour
pending deadline. Session start/switch/branch/tree/shutdown cleanup removes
remaining results; a file being read is not deleted underneath the caller, a
failed delete is retried later, and unknown temp entries are never recursively
deleted. Each store directory has a private owner marker; a cross-process sweep
reclaims it only when the marker proves the owner on the same host/PID namespace
is gone. See [`docs/BACKGROUND.md`](docs/BACKGROUND.md) for the full state
machine, failure modes, and diagnostic recipes.

Cancellation:

- Cancel with `write({"path":"proc://<groupId>/kill"})`. The kill cascades to
  pool items.
- Then run collect. A readable snapshot yields a drained `cancelled` group and a
  gated file (readable, but not success); a destroyed pool service yields an
  explicit state/handle error and no file. OMP may send no async-result notice
  after cancellation.
- Do not re-dispatch a cancelled group unless the user asks for a new run.

## RPC / headless

A foreground group is one native eval tool result — there is **no live per-task
update stream** and no custom widget/RPC snapshot channel.

- Content: the bounded text digest — per-task status, clipped preview, duration +
  model, `agent://` handle for the full transcript.
- Details: the final result carries the stable snapshot shape `{ protocol: "omp-task-group/v1", snapshot,
  gate, ... }`. The hook decodes OMP's native `cells[].views[].view.value` transport
  and does not leak the per-cell view chunks.
- Plain/headless and TUI/RPC modes receive identical final content/details.
- An explicit background group first returns a dispatch receipt
  (`details.background.state="dispatched"`, delivery `"workpool-async"`,
  verified `itemIds`), then OMP's native async-result notice. The model runs the
  explicit `ompTaskGroupCollect` envelope; a pending collect is not success.
  When collect reports ready, the gated result arrives through
  `task_group_result` segments, and `read`/`consume` delete only the registered
  private file.

## Architecture

See `docs/ARCHITECTURE.md`. Highlights:

- **Standard eval envelope**: usage is `eval` code containing exactly
  `ompTaskGroup(<strict JSON>)`. The plugin never shadows `eval`; a `tool_call`
  hook recognizes the envelope (rewriting the cell to run the compiled group
  program) and a `tool_result` hook finalizes the result.
- **Compiled program** uses the public JS eval prelude. Foreground groups emit
  protocol-tagged JSON chunks through `console.log()`; the finalizer reassembles
  them from `details.cells[].views[].view.value`. Explicit background groups use
  two cells: a dispatch cell that pushes to a native Workpool and retains the
  handle in the eval kernel, and an explicit collect cell that reads only
  `status()`/`peek()`, runs the shared gate, and writes one atomic checksummed
  file. No wait, polling loop, detached promise, or plugin notification is
  involved.
- **One state reducer** → one snapshot protocol (`omp-task-group/v1`); every text
  and detail consumer reads only that final snapshot.
- **Private-API import guard**: CI fails if any source file imports OMP internals
  (`scripts/check-private-imports.ts`, mirrored as a test).

## Development

```bash
bun install
bun run typecheck        # tsc --noEmit (strict)
bun test                 # unit tests incl. mocked-kernel program execution
TEST_INTEGRATION=1 bun test tests/integration   # real omp run (10 sonic children)
bun run lint:private-api
bun run build
```

## Known limits

- The current public Eval surface does not expose per-child token counts; snapshots
  carry `null` tokens and telemetry uses budget-delta estimates.
- No live per-task stream: the parent sees one final tool result. Output lines the
  native Eval cell may show while a group runs are ordinary cell output, not Task
  Group transport.
- The group cell uses native Eval's public tool UI (code + output); the plugin
  cannot swap in a custom live renderer.
- `effort` is accepted but inert until OMP exposes effort on Eval `agent()`.
- Pool has no per-item duration or resolved-model fields in its public snapshot.
  Unrecoverable batch output fails the group; tasks are not rerun after dispatch.
- Background execution is an explicit two-phase native Workpool opt-in, not an
  `eval.autoBackground` mode. It requires a pool-eligible homogeneous
  all+collect spec; the dispatch cell returns after verified `push()` ids and
  never waits. OMP's native async-result notice may show ungated aggregate text;
  the model must run the explicit `ompTaskGroupCollect` envelope, which reports
  `pending` while the pool drains. A kernel reset or session change loses the
  retained handle and collect fails closed. Collect writes one checksummed file;
  `task_group_result` is required to read and consume it, so delivery is never
  pushed automatically. A cancelled pool may produce no notice; collect then
  reports a cancelled drained group or an explicit handle/state failure, never a
  fake result. An observed, unconsumed result file expires after
  `background.retentionMinutes` (default 30 minutes, range 1–1440) without access
  or delivery progress; access renews it only while unexpired, and an expired
  result is reclaimed rather than revived. A partially delivered result is kept
  until the caller finishes or session cleanup runs. Repeated consume returns a
  bounded, non-expiring receipt (most recent 256 per session) without a second
  delete or content delivery; an id never consumed in the session remains not
  found.
- The foreground `eval.autoBackground` scan is best effort. An in-memory
  settings change after the scan is not visible; `details.async` remains the
  runtime fail-closed check for foreground groups. The two-phase background path
  is not gated by that scan.
