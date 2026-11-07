# Background delivery contract — two-phase native Workpool

`omp-task-group` supports background execution only as an explicit, two-phase
native Workpool opt-in. One short dispatch cell starts the pool; OMP's own
async-result notice signals completion; an explicit collect cell reads the
retained handle and writes one checksummed result file; `task_group_result`
then reads and consumes that file. This document is the diagnostic reference
for operators, tests, and the model-facing flow.

There is no plugin watch promise, timer, polling loop, second notification, or
`AutoBackground` admission path. Background never depends on OMP's
`eval.autoBackground` setting.

## Opt-in and admission

| Spec | Behavior |
| --- | --- |
| `background: "auto"` / `"foreground"` (`execution.mode` same) | One foreground eval cell. If OMP backgrounds it anyway, the result hook fails closed. |
| `background: "require"` | Explicit two-phase Workpool background opt-in. |
| `execution.mode: "background"` | Same explicit opt-in. |
| explicit foreground + explicit background | Schema error; no compilation. |

Background is accepted only when **all** of these hold:

- `join.mode="all"` and `failure.mode="collect"`;
- homogeneous tasks: one agent and identical tool sets;
- `execution.concurrency="auto"`, no per-task `schema`, no per-task `isolated`;
- `output.mode` is `"compact"` or `"structured"` (a summarizer would have to
  wait inside collect, so `"summarize"` is rejected);
- `execution.strategy` is not `"fanout"`;
- `execution.pool.enabled` is not `"off"` and the Eval prelude exposes
  `workpool()`.

The numeric `execution.pool.threshold` is an auto-selection preference; it is
not applied to an explicit background opt-in. A two-task homogeneous group is
valid even with the default threshold of 6. The plan must still resolve to the
`pool` strategy; `background` never falls back to Fanout and never waits in the
dispatch cell. Rejections are `tool_call` blocks with the plan reasons.

A background dispatch and a collect both refuse `reset: true`: the Workpool
handle lives in the shared eval kernel, and a reset would drop it (and any other
live background group).

## Phase 1 — dispatch

The rewritten cell:

1. checks the same admission rules again at runtime;
2. calls `workpool(agent, { name: groupId, context, tools })`;
3. verifies the pool object and that a fresh pool is empty (`status()` and
   `peek()`), so no other push can be mistaken for this group;
4. calls `pool.push(...prompts)` once with every task prompt. Each prompt
   requires exactly one Workpool `yield` keyed by its 1-based batch key;
5. requires exactly one unique non-empty string id per task;
6. retains `{ version, groupId, resultId, pool, ids, taskNames,
   dispatchedAtMs }` in `globalThis.__ompTaskGroupPoolBackgroundV1.groups`,
   keyed by `groupId`;
7. emits one JSON view and returns. It does **not** call `wait()`, `close()`,
   `tool.wait`, `tool.read("proc://")`, or start any detached promise.

The patched tool result is a short **dispatch receipt**, never a result:

```json
{
  "protocol": "omp-task-group/v1",
  "groupId": "tg…",
  "state": "dispatched",
  "background": {
    "protocol": "omp-task-group/background-v1",
    "requested": true,
    "delivery": "workpool-async",
    "state": "dispatched",
    "groupId": "tg…",
    "resultId": "tgbg_…",
    "poolName": "tg…",
    "itemIds": ["…"],
    "taskCount": 6,
    "collect": "ompTaskGroupCollect({\"groupId\":\"tg…\",\"resultId\":\"tgbg_…\"})",
    "path": "/…/tg….json"
  }
}
```

`path` is the planned private result-file path; it does not exist until collect
writes it. Success is confirmed **only** by this in-cell receipt with the real
item ids. `details.async` on the dispatch cell is never success: the receipt was
not delivered, dispatch is unconfirmed, the host keeps the record so a handle
that did run can still be collected, and the model must not re-dispatch.

The dispatch and collect cells are short control cells and must complete
synchronously. A host configuration that auto-backgrounds every eval
(`eval.autoBackground.enabled=true` with `thresholdMs=0`) can swallow the
dispatch receipt; dispatch then fails closed as unconfirmed. The plugin never
changes settings: if that configuration is active, set
`eval.autoBackground.enabled=false` for this route (the Workpool background path
itself does not use that setting).

On `workpool()`/`push()` failure or an invalid id set the cell closes the pool,
attempts `proc://<groupId>/kill`, and emits a failed receipt
(`dispatched`, `cancelled`, optional `cancelError`). The host reports an error
and discards the record. No task is rerun. If cancellation could not be
confirmed, inspect `proc://` before any retry.

## Native completion notice — not the result

OMP delivers its own async-result notice when the pool settles. It is produced
by the host from the pool aggregate and may contain raw, **ungated** aggregate
child text, truncated by OMP's preview limits. It is not the Task Group result,
not a Result Gate output, and not sufficient to report success.

The plugin sends no notification of its own. Do not treat any preview text as
the group outcome. The notice's only role is to tell the model that collect can
now be attempted. Cancellation may produce no notice at all.

The OMP 18.16.0 Workpool aggregate and `peek()` both use the same batch output.
Shortening worker output would therefore also remove data needed by collect;
this plugin does not truncate workers to hide notification cost. The background
flow is **not a single bounded delivery**: native preview, collect and gated
read all enter the parent conversation. In one real three-item sample, the
native notice was 1,274 characters / 1,337 UTF-8 bytes (519 `o200k_base`
tokens); the separate gated-read response was 628 characters / 690 bytes
(261 tokens, including its receipt). These are local tokenizer counts for one
sample, not provider usage or a bound. OMP 18.16.0 spills async results longer
than 12,000 characters to an artifact with a 4,000-character inline preview;
this is a host transport limit, not the Task Group gate limit.

Compared with a foreground group, background adds a native async notification
and explicit collect/read/consume tool interactions; it does not reduce parent
wakeups or context cost versus foreground. It can reduce separate completion
notifications compared with launching individual native background tasks, but
the host may batch deliveries. `/task-group stats` estimates only gated group
deliveries and excludes these background interactions and native previews.

## Phase 2 — explicit collect envelope

After the native notice, the main agent runs one more ordinary eval cell:

```
ompTaskGroupCollect({"groupId":"tg…","resultId":"tgbg_…"})
```

Grammar is the same strict envelope grammar as `ompTaskGroup`: one JSON object,
exactly the two keys `groupId` and `resultId`, no path, no extra fields, no
other JavaScript, optional trailing whitespace and one `;`. The host validates
both identifiers, requires its own registered record for that result id, checks
the group id matches, and requires a pool-plan record. The collect cell must run
in the same eval kernel as dispatch.

The collect cell reads only the retained handle:

- `await pool.status()`
- `await pool.peek()`

It never calls `wait()`, never reads `proc://`, never consumes another job, and
never mutates the registry entry. It reports one of three states:

| `background.state` | Meaning | Tool result |
| --- | --- | --- |
| `pending` | Queued/running items, `peek().pending !== 0`, or a non-terminal batch. `status.closed` is reported but is not required: a killed pool may be fully terminal without flipping it. | `isError: false`, explicit “still draining”, counts/pool facts, no file, handle kept. Call collect again later; nothing was waited on. |
| `ready` | The pool is drained and the snapshot passed strict decoding. The collect cell ran the shared Result Gate and stored the payload through the write-approved `task_group_store_result` tool. | `isError` false only when `groupState="completed"`; `failed`/`cancelled` groups are `isError: true` but the file is readable. |
| `failed` | Handle missing (`handle`), status/peek call or shape error (`state`), strict decode/coverage error (`decode`), or the write-approved store rejected/failed the write (`write`). | `isError: true`, explicit stage/reason, no verified file. The handle is kept for a retry except when it was already lost. |

### Strict terminal decode

A drained snapshot is decoded with the same rules as the foreground Pool path:

- exactly one pushed id per task, unique and non-empty;
- every batch has a string id/agent, valid status, known item ids, and each id
  appears in exactly one batch;
- a completed batch has a string `output`, no duplicate JSON keys, valid JSON
  object, and exactly its declared item ids as keys;
- each item value is exactly `{status:"succeeded", value}` (success, unwrapped),
  exactly `{error}` (failed), or any other defined JSON value (succeeded and
  preserved verbatim: strings stay text, objects stay structured); a missing
  value is failed. A JSON-string-encoded value is unwrapped only when it parses
  to one of those two exact envelopes;
- terminal `failed`/`cancelled` batches are legitimate outcomes, not protocol
  errors; a failed batch reports its bounded native output as each item error;
- Workpool status item counts must agree with the decoded outcomes, no
  queued/running items may remain, and `peek().pending` must be 0 (`closed` is
  reported but optional, because a killed pool can be fully terminal without
  flipping it).

Malformed snapshots, missing/duplicate coverage, and count mismatches fail
closed: no result file is written and no partial result is reported. A group
where every batch was cancelled is a `cancelled` group; all-failed is `failed`;
at least one success is `completed`, with failures still shown by the gate.

The payload embeds the in-cell shared Result Gate text (`gateText`,
`gateMode`, `gatedChars`, optional `gateError`), exactly like the foreground
program. `task_group_result` verifies the file and serves that gate text; it
does not re-gate with a different implementation.

## Result file, read, and consume

One wrapper JSON file per group is written to
`<os.tmpdir()>/omp-task-group-results-<random>/<groupId>.json`:

```json
{
  "format": "omp-task-group/background-result-v1",
  "protocol": "omp-task-group/eval-result-v1",
  "groupId": "tg…",
  "resultId": "tgbg_…",
  "createdAtMs": 1760000000000,
  "payloadChars": 1234,
  "sha256": "64 lowercase hex chars",
  "payloadJson": "{\"protocol\":\"omp-task-group/eval-result-v1\",…}"
}
```

`sha256` covers the UTF-8 bytes of `payloadJson`, not a re-serialized object.
The collect cell performs no filesystem I/O. It passes `groupId`, `resultId`,
and the bounded payload to `task_group_store_result`, which declares
`approval: "write"`. The tool accepts no path and requires the per-execution
capability embedded in the host-compiled Collect cell; each Collect request
rotates it, so a transcript replay cannot reuse the previous capability. Direct
tool calls without the active matching Collect capability are rejected. It
validates group ownership, session registration, protocol, exact outcomes,
text, and a 4 MiB UTF-8 payload cap. It writes `openSync(tmp, "wx", 0o600)` →
write → fsync
→ close → `renameSync(tmp, final)` and verifies the final file by reading it
back. A partial or unverified file never yields a ready receipt.

Collect is safe to repeat: it re-reads status/peek and stores the same payload
with the same checksum. An identical retry reports `alreadyStored`; a different
payload for an existing result is rejected. It never re-runs tasks.

`task_group_result` actions:

| Action | Parameters | Result |
| --- | --- | --- |
| `read` | `id`, optional `offset` | Next 4000-character segment of the gated text. Omit `offset` to continue. `details.background.complete=true` means every character was delivered. |
| `status` | `id` | `pending`, `ready`, or `materialized`; path, checksum after materialization, delivered/total chars, TTL, and the record's configured `retentionMs`. |
| `consume` | `id` | Deletes the private file only after every character was delivered. A repeated consume returns a non-error receipt and deletes/re-delivers nothing. |

`read` verifies the wrapper format, protocol, group/result identity,
`payloadChars`, SHA-256, file ownership, private mode `0600`, directory `0700`,
regular file (no symlink), and size ≤ 32 MiB before returning anything. It then
runs the same exact-coverage payload decoder used by foreground results. A
license mismatch is an explicit integrity error, never a partial success.

`background.retentionMinutes` (default 30, range 1–1440) bounds an observed,
unconsumed file after collect writes it; access and delivery progress renew the
window while it is still unexpired. A group with no file yet uses a fixed
two-hour pending deadline. Retention never enables background execution and
never changes OMP settings.

## Cancellation

Cancel with the normal write tool:

```
write({ "path": "proc://<groupId>/kill" })
```

The kill cascades to the pool and its items. Then call the collect envelope:

- if the handle and snapshot are still readable, collect reports a drained
  `cancelled` group and writes the gated file (readable, but `isError: true`);
- if the pool service is already gone and `status()`/`peek()` fail, collect
  reports `state:"failed"` with an explicit state/handle error and writes no
  file. No result is fabricated.
- OMP may deliver no async-result notice after cancellation. Collect is safe to
  retry.

Do not re-dispatch a cancelled group unless the user explicitly asks for a new
run.

## Kernel handle lifecycle and isolation

- Handles live in the shared JS eval kernel global
  `__ompTaskGroupPoolBackgroundV1`, keyed by `groupId`; each entry also carries
  the result id, item ids, and task names.
- The kernel keeps that entry until the kernel is reset or the session ends.
  Collect deletes nothing there; `task_group_result consume` deletes only the
  result file.
- A kernel reset or entry/result-id mismatch makes collect fail with
  `stage:"handle"`; a session switch clears the session's result registration,
  so collect is rejected before the cell runs even if the old session is later
  reopened. The pooled work may still be running; do not re-dispatch blindly.
- In an OMP 18.16.0 RPC probe, remote compaction completed before collect and
  the retained handle still produced a successful collect. This does not
  guarantee that the model retains the IDs in its compacted context.
- After a reset, `proc://` and `agent://` may expose raw output while the owner
  process remains alive, but this is not a verified or gated Task Group result.
  If a result was successfully collected before reset, the existing result file
  can still be read in the same session.
- Multiple background groups are isolated by group id and result id. Collect
  touches only its own entry. A foreign async job or live service during collect
  is irrelevant because collect never waits or consumes anything.
- If the dispatch cell returns without a verified receipt, the record remains
  pending and collect is the only way to learn whether a handle exists.

## Cleanup and safety invariants

- The store directory is created with `mkdtemp` under the OS temp root and
  chmod `0700`; the result file is `0600`. Ownership is checked against the
  current uid.
- Reads use `O_NOFOLLOW` plus `fstat` on the opened descriptor, not a path
  re-check after open.
- Deletion only targets a registered path after containment, file-name,
  regular-file, and ownership checks. There is no recursive delete and no
  model-supplied path.
- Cleanup runs on `session_start`, `session_switch`, `session_branch`,
  `session_tree`, and `session_shutdown`; no timers and no polling.
- A record that is loading or partially delivered is never deleted underneath
  the caller. A failed delete keeps the record (marked `deletePending`) so the
  next access retries it.
- Consumption receipts hold no payload text, are capped at 256 per session, and
  are never time-expired.
- Each store directory has a private `.owner` marker (pid, hostname, PID
  namespace). Cross-process sweeping reclaims a directory only when that marker
  proves the owner is gone on the same host/PID namespace; anything
  inconclusive is preserved (fail safe). Time alone never authorizes deletion.

## Approval boundary

The collect cell has no filesystem I/O. It hands the bounded result to
`task_group_store_result`, a plugin tool declared with `approval: "write"`.
OMP's per-tool approval gate therefore applies to the actual write, including
when the call comes through the Eval `tool.*` bridge. The tool accepts no path,
validates the registered group and deterministic Result Gate payload, and
rejects direct calls unless the matching Collect Eval is actively executing.
Thus an unrelated Eval or direct model tool call cannot fabricate a stored
snapshot. If approval is denied or the write fails, collect reports
`state:"failed"`, `stage:"write"`, and no ready file; it never falls back to
hiding the write in the Eval cell.

Dispatch and foreground programs contain no background result-file writes.
Real isolated OMP 18.16.0 tests with Smart Approve 2.7.2 passed in both
extension load orders: dispatch and collect reached `ready`, then read and
consume deleted the file. A headless run with
`tools.approval.task_group_store_result: prompt` was denied and produced
`state:"failed"`, `stage:"write"`, no result file, and no consume.

## Notification vs final result

| | Native async-result notice | Final Task Group result |
| --- | --- | --- |
| Source | OMP host, pool aggregate | in-cell shared gate, stored by `task_group_store_result` |
| Text | ungated/raw, possibly truncated | bounded and structured by the Result Gate |
| Trust | informational only | verified by `task_group_result` |
| Action | run the collect envelope | read segments, then consume |

A native notice alone is never success. A `pending` collect is never success. A
collect `ready` receipt is a verified collection; the gated text still has to be
read from `task_group_result`, and `isError` reflects the group state (`failed`
or `cancelled` is not success even though the file exists).

## Quick diagnostic recipes

```bash
/task-group background   # two-phase requirements + foreground autoBackground scan
/task-group config       # effective config; background.retentionMinutes
/task-group explain      # why the last plan chose pool or fanout
```

Foreground compatibility still scans OMP's `eval.autoBackground` setting on a
best-effort basis; that scan exists only to protect foreground groups from
host auto-backgrounding. It does not gate the two-phase Workpool path.

A representative background request:

```js
ompTaskGroup({
  "context": "Each child returns one token.",
  "background": "require",
  "tasks": [
    { "name": "a", "agent": "sonic", "task": "Return token A." },
    { "name": "b", "agent": "sonic", "task": "Return token B." }
  ],
  "join": { "mode": "all" },
  "failure": { "mode": "collect" }
})
```

Do not touch project or user OMP settings to make background work. If the plan
is not pool-eligible, the block lists the exact reason; change the spec or run
the group in the foreground.
