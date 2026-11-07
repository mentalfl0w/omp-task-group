# omp-task-group — Architecture

## Layering

```
┌────────────────────────────────────────────────────────────┐
│ src/index.ts            extension wiring (public API only) │
│   ├─ tool_call hook: envelope detect → input rewrite/block │
│   ├─ tool_result hook: finalize from OMP JSON views          │
│   ├─ hooks: before_agent_start (policy) / missed-group     │
│   ├─ /task-group command                                   │
│   └─ telemetry rehydrate + capability probe                │
├────────────────────────────────────────────────────────────┤
│ ENGINE (src/engine)                                        │
│   planner → strategy decision + reasons                    │
│   runner  → fold decoded result → gate → return            │
│   (compile / SPAWN / RUN / JOIN execute in hook + cell)    │
├────────────────────────────────────────────────────────────┤
│ COMPILER (src/compiler)                                    │
│   envelope → self-contained JS program (public prelude)    │
│   EVAL_RESULT_PROTOCOL "omp-task-group/eval-result-v1"      │
├────────────────────────────────────────────────────────────┤
│ FINALIZER (src/backend/eval-result.ts)                      │
│   decodeEvalGroupResult: details.cells[].views              │
│   → stable snapshot details (omp-task-group/v1)            │
├────────────────────────────────────────────────────────────┤
│ KERNEL (inside the native eval cell, compiled program)     │
│   Eval: agent / wait / completion / workpool / console.log  │
│   tool bridge: read / wait / write via public APIs           │
└────────────────────────────────────────────────────────────┘
│ RESULT GATE (src/result)   bound the delivered bytes       │
│ BACKGROUND (src/background) private file store, checksum,  │
│   segmented read/consume, TTL + session cleanup            │
│ PRESENTATION (src/presentation)  digest text from snapshot │
│ TELEMETRY (src/telemetry)  aggregate + session entries     │
```

Dependency rule: everything depends inward; presentation reads only the stable
snapshot; the compiled kernel program never imports anything.

## What runs where

Task Group does **not** register or shadow `eval`. The call the model makes is an
ordinary native eval call (`language: "js"`, `timeout: 0`, `code` containing
exactly the envelope). Two hooks turn that call into a group:

1. **`tool_call` (recognition + rewrite).** The hook scans the eval `code` for the
   envelope grammar — exact `ompTaskGroup(<strict JSON>)` call, outer whitespace
   and one optional terminal semicolon allowed, nothing else. Three outcomes:
   - valid envelope → returns `{ input: rewrittenNativeEvalInput }`: the cell is
     rewritten to run the compiled group program (effective input is revalidated
     by the host before execution);
   - recognized but malformed envelope → `{ block: true, reason }` with a precise
     reason (a recognized malformed envelope is never executed as ordinary JS);
   - anything else → untouched ordinary eval (never claimed as plugin-owned).
2. **`tool_result` (finalization).** The compiled program serializes the wire
   payload (`protocol: "omp-task-group/eval-result-v1"`, group id, strategy,
   state, clipped outcomes, and optional summary/error) and sends it through
   `console.log()` as OMP JSON-view chunks. The eval result exposes those values
   at `details.cells[].views[].view.value`. `decodeEvalGroupResult` selects the
   exact protocol, transport, and group id, verifies every chunk, parses the
   payload, validates task names/statuses, and folds outcomes into the stable
   snapshot details — `{ protocol: "omp-task-group/v1", snapshot, gate, ... }`.
   The hook then replaces the native result with the bounded digest and snapshot.

OMP v18.16 retains at most 16 JSON views per cell and drops a view over 32 KiB.
The compiler emits 14,000-character chunks; results requiring more than 16
chunks produce a fail-closed size error instead of a partial result.

There is no custom live-update stream, RPC snapshot channel, or widget. The
`console.log()` JSON views are ordinary cell output used only for final result
transport; they do not carry live per-task progress.


## Why the parent sees one result

1. Fanout runs inside one native Eval cell. One terminal result is consumed
   per handle; if a wait fails while a child is live, the handle is canceled
   and reaped with bounded retries. Early-exit joins also reap pending handles,
   and queued tasks receive a cancelled outcome.
2. Pool runs only for eligible `all + collect` batches. Before dispatch, the
   program checks `proc://` for competing waitable jobs/live agents and probes
   empty `wait()` only when no owned service would block it. Once the Pool job
   exists, service completion events return its job snapshot; the loop continues
   until it consumes the Workpool aggregate result through `tool.wait()`.
3. Pool outcomes map each `pool.push()` item id to exactly one `peek().batches[]`
   entry and one validated JSON result envelope. A failed preflight falls back to
   Fanout before `push()`; any uncertain post-dispatch result is canceled, reaped,
   and returned as failure without rerunning the tasks.
4. One foreground native Eval result, finalized by `tool_result`, is the normal
   Task Group continuation. An explicit background opt-in uses the two-phase
   Workpool contract described below; a foreground group that the host
   backgrounds fails closed instead of being treated as a result.

## Envelope grammar

- Exactly one `ompTaskGroup(<strict JSON>)` call; argument is strict JSON
  (double-quoted keys, no comments, no trailing commas). No arbitrary JavaScript.
- A valid envelope must be distinguishable from a non-envelope, and a
  recognized-but-malformed envelope must be distinguishable from both (blocked
  with a reason, never silently run as a normal cell).

## Compiler invariants

- Spec embeds as JSON inside the rewritten cell — no escaping holes.
- The compiled program uses OMP's public Eval prelude and ordinary
  `tool.read` / `tool.wait` / `tool.write` calls; no private imports.
- The `omp-task-group/eval-result-v1` payload travels through bounded JSON-view
  chunks: 14,000 characters per chunk, at most 16 chunks per cell.
- Per-task output is clipped before transport. No `import` / `require` /
  `process` appears in the generated program.
- Join semantics:
  - `all + collect` → wait until every child settles
  - `all + fail_fast` → first failure cancels the rest
  - `any` / `quorum` → a satisfied condition cancels the rest
- Pool is limited to homogeneous `all + collect`, with no per-task schema,
  isolation, or explicit concurrency override.
- Pool results are decoded from per-batch JSON keyed by returned Workpool item
  IDs. Exact identity coverage, unique assignment, batch terminal state, and
  aggregate item counts must agree before success is accepted.
- Pool completion uses the ordinary `wait` tool, not Eval `wait(handles)` and
  not a polling loop. The preflight avoids consuming other caller-owned results.
- Explicit two-phase background compilation: the dispatch cell creates a named
  Workpool, pushes tasks, verifies item ids, retains the handle plus ids in a
  kernel global, and returns a single receipt view; it contains no wait call.
  The collect cell reads only `status()`/`peek()`, reports pending while the
  pool drains, and after strict decoding runs the shared Result Gate in-cell,
  then writes one atomic file (SHA-256 over the payload JSON, temp `0600` in the
  host-created `0700` directory, fsync, rename). No payload text is printed and
  no notification is sent. Write/decode/state failures leave no trusted file.

## Finalizer invariants (eval-result)

- `decodeEvalGroupResult(details, spec, expectedGroupId)` reads native
  `details.cells[].views[].view.value`; missing, foreign, duplicate, incomplete,
  malformed, or oversized chunks fail closed.
- The decoder validates the inner protocol/group id, result shape, task names,
  and statuses. `details.async` on a foreground or dispatch cell is a
  barrier/protocol violation; it is never success. Background dispatch and
  collect use separate single-view receipt transports decoded by
  `decodePoolBackgroundDispatch` / `decodePoolBackgroundCollect`.
- The background tool verifies the wrapper format, group/result identity,
  ownership, private modes, size, and SHA-256, then calls the same
  `decodeEvalPayload`/`runTaskGroup` pipeline. Background gate text is computed
  in-cell by the shared gate core; foreground results instantiate that same core
  host-side. A background file is never decoded into a second transport format.
- The shared gate treats per-task status lines, failure previews, the
  join result/group error, and requested `agent://` handles as mandatory
  metadata. Only body previews/digests are compressed to honor
  `output.maxTotalChars`; clips never split UTF-16 surrogate pairs. Structured
  mode stays valid JSON, replacing oversized child values with
  `{"$truncated":<chars>}` markers (or a top-level `omittedResults` count when
  markers cannot fit). When mandatory metadata cannot fit, the gate returns an
  explicit `error`; the background payload carries it as `gateError`, and the
  runner reports `isError: true` instead of prefixing a success summary.
- Final details always use the stable snapshot shape
  (`omp-task-group/v1`); raw eval views never leak to the caller.

## Background execution (two-phase native Workpool)

OMP's native Eval auto-background exists, but this plugin does not use it as a
delivery path and does not depend on `eval.autoBackground`. On OMP 18.16 a
`workpool.push()` cell returned in milliseconds while the pool kept running,
OMP delivered one `async-result` notice when the pool settled, and the same JS
kernel could still call `pool.status()`/`peek()` afterwards. The notice is a
text preview of the pool aggregate, not a typed result.

Background execution is therefore an explicit, two-phase contract:

1. The spec opts in with `background: "require"` or
   `execution.mode: "background"`. `auto` and `foreground` stay foreground. The
   plan must resolve to `pool`: homogeneous `all + collect`, `concurrency=auto`,
   no per-task schema/isolation, compact/structured output, pool not disabled.
   The numeric threshold is not applied. A non-pool plan is blocked before
   compilation; there is no Fanout fallback. Background does not read the
   `eval.autoBackground` scan.
2. The dispatch cell creates `workpool(agent, {name: groupId, context, tools})`,
   verifies an empty pre-dispatch status/peek, pushes every task prompt once,
   and requires exactly one unique non-empty item id per task. It stores
   `{groupId, resultId, pool, ids, taskNames}` in
   `globalThis.__ompTaskGroupPoolBackgroundV1` and returns a single receipt
   view. It never calls `wait()`/`close()` on success, never starts a detached
   promise, and sends no notification. A push/create failure closes and kills
   the pool, emits a failed receipt, and never reruns tasks.
3. The host confirms dispatch only from that receipt and its verified ids.
   `details.async` on the dispatch cell is never success; the record is kept so
   a handle that did run can still be collected, and the model is told not to
   re-dispatch.
4. OMP's async-result notice is informational only. Its preview may contain
   ungated aggregate child text and truncation; it is never treated as the Task
   Group payload.
5. After the notice, the model runs exactly one collect envelope:
   `ompTaskGroupCollect({"groupId","resultId"})` — strict JSON, exactly two
   keys, no path, in the same eval kernel (`reset` is rejected). The host
   validates both ids against its registered record.
6. The collect cell reads only `await pool.status()` and `await pool.peek()`.
   It never calls `wait()`, never reads `proc://`, and never consumes another
   job. If the pool is not drained (queued/running items, `peek().pending>0`,
   or a non-terminal batch), it emits `state="pending"` and keeps the handle.
   `status.closed` is reported but is not required: a killed pool can be fully
   terminal without flipping it.
7. On a drained snapshot it strictly decodes the Workpool items: exact one-id
   per task, unique assignment, batch/item identity, duplicate-JSON-key and
   coverage checks, terminal failed/cancelled batches as outcomes, and
   status/peek count agreement. Malformed snapshots fail closed with no file.
   A valid snapshot runs the shared Result Gate core in-cell and writes one
   atomic wrapper: `0700` directory under the OS temp root, `0600` file, temp +
   fsync + rename, SHA-256 over the exact payload JSON string. The collect
   receipt carries `state="ready"`, `groupState`, task counts, path, checksum,
   and payload length.
8. `task_group_result` reads by opaque id, verifies format/identity/ownership/
   private mode/size/checksum, decodes with the same exact-coverage decoder, and
   serves the in-cell gate text computed by the shared gate core (the foreground
   host instantiates that same core). It returns 4000-character segments;
   `consume` deletes the file only after every character was delivered.
   Repeating `consume` returns a no-op receipt with no second deletion and no
   re-delivered content; an id never consumed in the session stays not found.
   Receipts are bounded to the most recent 256 per session and never
   time-expired.
9. Cancellation uses the ordinary `write` tool with
   `proc://<groupId>/kill`, which cascades to pool items. A readable snapshot
   yields a drained `cancelled` group and a gated file; a destroyed pool
   produces an explicit state/handle failure and no file. OMP may send no
   async-result notice after cancellation. There is no fabricated success. A
   kernel reset or session change loses the retained handle; collect reports
   `stage="handle"` instead of inventing a result.

The store never accepts a path from the model. It refuses symlinks, foreign
owners, non-private modes, oversized files, and paths outside its own directory,
and deletion is limited to the exact registered file. Cleanup runs on session
start/switch/branch/tree/shutdown and lazily on access; it never runs on a timer,
never waits on a detached promise, and marks in-flight records for deletion
after their read completes. Partially delivered results are never expired, and
failed deletes keep a retryable record. Each directory has a private `.owner`
marker; stale directories from a crashed process are swept only when that
marker positively proves the owner (same host and PID namespace) is gone, with
the prefix, owner, mode, and exact file-name pattern checks. Empty directories
and unprovable ownership fail safe. An unknown entry makes the whole directory
ineligible, so nothing is recursively deleted.

## Configuration diagnosis (best effort)

`scanAutoBackgroundConfig` is a tri-state configuration scan, not a guarantee:

- **disabled** — an inspected, highest-precedence layer explicitly sets
  `eval.autoBackground.enabled=false`, or no inspected layer configures it
  (OMP's setting default is `false`).
- **enabled** — a layer explicitly enables it.
- **unknown** — a higher-precedence source could not be read/parsed, so the
  effective value cannot be established.

`enabled` and `thresholdMs` are resolved independently: an unreadable layer only
stops mattering when a later inspected layer overrides that same key. The
scan's `backgroundReady` value requires both `state=enabled` and a resolved
`thresholdMs=0`; it describes host auto-background behavior for the foreground
protection check and is not used as two-phase background admission.

Sources are scanned in this order (later entries override earlier ones): the
active agent directory's `config.yml`/`config.yaml` (or
`~/.omp/profiles/<name>/agent` for a named profile, which ignores
`PI_CODING_AGENT_DIR`; otherwise `PI_CODING_AGENT_DIR` overrides the default
agent directory), project `.omp/settings.json` then `.omp/config.yml` (the YAML
file overrides the JSON file), `.claude/settings.json`, `PI_CONFIG_FILES`, then
`--config` overlays.
`--config` and `PI_CONFIG_FILES` values are resolved relative to the active cwd
and support `~`. A missing `--config` overlay or a YAML/JSON parse error makes
the affected key `unknown` rather than claiming safety.

Only **disabled** allows a foreground group. This scan exists solely to protect
foreground groups; the explicit two-phase Workpool background path does not
read `backgroundReady` and is not blocked by **enabled** or **unknown**. The
plugin never mutates user settings. OMP exposes no public API for the effective
setting and runtime overrides are invisible; a foreground group that is still
backgrounded by the host fails closed on `details.async`. The host owns that
job; the plugin does not attempt to cancel it.

## Public API discipline

`src/types.ts` reproduces documented contracts only (`docs/extensions.md`,
`docs/tools/eval.md`, `docs/tools/wait.md`, and `docs/tools/read.md` for `proc://`).
The check is enforced by `scripts/check-private-imports.ts` (CI) and `tests/unit/private-api.test.ts`.
No `@oh-my-pi/*` runtime imports anywhere — the host's bundled copy is never
reached through module graphs.
