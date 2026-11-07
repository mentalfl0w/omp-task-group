# omp-task-group — Compatibility

Audit target: current upstream `can1357/oh-my-pi` main, `@oh-my-pi/pi-coding-agent` v18.16.0, audited on 2026-11-03. The existing live integration suite ran against local OMP v18.14.1; focused background probes ran against local OMP v18.16.0 on 2026-11-06 and verified: `pool.push()` returns while the cell finishes immediately with `eval.autoBackground=false`; OMP delivers one native notification per pool; other tools run in parallel; after completion the same JS eval kernel retains `pool.status()`/`peek()` with complete results; `proc://<pool>/kill` cascades. Runtime compatibility is checked from public Eval/tool results; the plugin does not guess from OMP version strings.

Official references: [Eval](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/eval.md), [Wait](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/wait.md), [Extensions](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md), and the [JS Eval prelude](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/eval/js/shared/prelude.txt).

## Public surfaces consumed

| Surface | Contract | Guard |
| --- | --- | --- |
| Extension factory | default export `(pi: ExtensionAPI)` | load crash → host skips plugin |
| `pi.on("tool_call")` returning `{ input }` | rewrites a valid Task Group envelope | effective input is checked at `tool_execution_start` |
| `pi.on("tool_call")` returning `{ block, reason }` | blocks a recognized malformed envelope | never executes malformed envelope code |
| `pi.on("tool_result")` returning a patch | replaces content/details/isError | only after exact wire-protocol decode |
| native Eval JSON views | `console.log()` values at `details.cells[].views[].view.value` | exact protocol, transport, group id, and complete chunk coverage |
| Eval `agent()` / AgentHandle | `.wait()`, `.status()`, `.cancel()`, `.handle` | terminal results are consumed per handle; a failed wait is canceled and retried boundedly for reaping |
| Eval `workpool(agent, { name, context, tools })` | async factory; `push`, `status`, `peek`, and `close` are async | object shape and pre-dispatch status are checked before `push()` |
| normal `tool.read({ path: "proc://" })` | caller-owned job/service inventory | Pool falls back before dispatch if another result could win `wait()` |
| normal `tool.wait({})` | waits for and consumes caller-owned jobs or a peer message | Pool uses it to consume the aggregate Workpool delivery; it is not Eval `wait(handles)` |
| normal `tool.write({ path: "proc://<id>/kill" })` | cancels an owned job | used only for Pool cancellation/timeout; cancellation status is checked |
| `before_agent_start` return `{ systemPrompt }` | routing policy injection | prompt replacement follows the documented contract |
| `ctx.ui.notify(text, level?)` | notification text | `/task-group` command only; never background completion |
| `ctx.abort()` | aborts a colliding rewritten Eval | called before the replaced code runs |
| `ctx.mode` | extension run mode | recorded in the configuration diagnosis; OMP's auto-background setting default is `false` in every mode (RPC pins that same default) |
| Node `process.argv` / env `PI_CONFIG_FILES`, `PI_CODING_AGENT_DIR` | diagnostic inputs for config discovery, not OMP extension APIs and not authoritative | only affect the best-effort barrier scan; never task execution; a named profile takes precedence over `PI_CODING_AGENT_DIR` |
| session entries via `pi.appendEntry` | telemetry persistence | package-qualified custom type |
| `ctx.sessionManager.getBranch()` | read-only branch | telemetry rehydrate |

Task Group does not register or shadow `eval` and does not use `ctx.invokeTool`.
It registers one auxiliary tool, `task_group_result`, for two-phase Workpool
background results. Ordinary Eval remains native; Smart Approve and other Eval interceptors see the
normal Eval call and normal nested tool approval gates.

The gated live suite accepts `SMART_APPROVE_EXTENSION` and exercises Smart Approve before and after Task Group. The integration run validated this path with Smart Approve 2.7.1 on OMP 18.14.1.

If `getAllTools()` reports any non-builtin `eval` wrapper, every such wrapper must expose `omp-task-group-pool-proc-cancel:v1` in its public `ToolInfo.description`. An unmarked wrapper, missing Eval ToolInfo, or unavailable inventory selects Fanout before Pool dispatch and records the reason in `/task-group explain`. Pool cancellation still calls ordinary `tool.write({ path: "proc://…/kill" })`; the marker only declares that the exact static cancellation path is recognized by the wrapper.

## Workpool result contract

OMP has no `pool.wait()`. Eval `wait(handles)` accepts AgentHandle and CompletionHandle values; it cannot wait for a Workpool. Task Group uses the separate zero-argument `wait` tool through `tool.wait({})`. Before creating a Pool, the compiled cell reads `proc://` to reject other waitable caller-owned jobs and live agents. It probes idle `tool.wait({})` only when no owned service exists, because a no-job wait would otherwise park on that service. With the Pool job active, a service completion returns an owned-job snapshot; the join loop consumes that event and continues waiting for the Pool. An unverifiable or busy preflight selects Fanout before any Workpool item is submitted.

OMP's public Wait has no caller-selectable timeout and a 30-minute safety cap. After cancellation, Task Group checks `proc://` before another Wait, makes at most two remaining event-driven Wait calls, and returns an explicit failure instead of looping if the aggregate still does not settle.

The JS call uses the current options-object form:

```js
await workpool(agentName, { name: groupId, context, tools });
```

Each Pool item prompt requires exactly one `yield` call with its 1-based item key. Success uses the yield `data` field (the exact final result as plain text; any JSON value is accepted); failure uses the `error` field, which OMP encodes as a one-field `{ error }` value. A legacy `data: { status: "succeeded", value }` envelope is also unwrapped. OMP's current Workpool implementation assembles these yields into each `peek().batches[].output` JSON object, keyed by the IDs returned from `pool.push()`. Task Group maps by those IDs, not by batch order or a guessed item count. A JSON-string-encoded value is unwrapped only when it parses to one of those exact protocol envelopes; any other JSON-object text is preserved as the worker's literal result, and code fences are never stripped or guessed. It rejects missing/duplicate item identities, duplicate JSON object keys, malformed/truncated JSON, unexpected keys, pending items, and status-count mismatches; a terminal failed batch is an outcome, not a protocol error, and keeps its bounded native diagnostic as the item error. The wait is event-driven; after aggregate completion, the plugin checks the complete snapshot and consumes the Workpool aggregate result through `tool.wait()`.

Pool is eligible only for homogeneous `join=all + failure=collect` groups with `execution.concurrency=auto`, no per-task schema, and no per-task isolation. Workpool does not enforce distinct task schemas, isolation, or the Task Group concurrency override. Those groups use Fanout. A runtime preflight or Workpool creation mismatch falls back to Fanout before `push()`; after `push()` is attempted, a thrown error or invalid ID mapping is treated as potentially dispatched, canceled and reaped, then returned as a failure. No post-dispatch failure reruns tasks through Fanout.

The two-phase background path is the same Pool contract without the join loop. Its dispatch cell creates the named Workpool, checks an empty pre-dispatch status/peek, pushes once, verifies one unique id per task, retains `{pool, ids}` in `globalThis.__ompTaskGroupPoolBackgroundV1`, and returns a receipt. It never calls `wait()`, never calls `close()` on success, and never starts a watch promise. After OMP's async-result notice, the explicit collect cell calls only `status()`/`peek()`: pending while queued/running/`peek().pending`/non-terminal batches remain; terminal snapshots go through the same strict item/batch decode and the shared in-cell Result Gate before one atomic file write. The host confirms dispatch only from the receipt's verified ids; `details.async` on the dispatch cell is never success.

The public Pool snapshot does not provide per-item duration or resolved-model metadata. Pool outcomes omit those fields rather than infer or fabricate them. Fanout records local per-handle duration; the current AgentHandle Eval surface does not expose a resolved model to this plugin.

The `/task-group` capability report marks Workpool and Task Group Pool as conditional. The extension context has no public API for inspecting the active Eval prelude, so the generated Eval validates the active Workpool binding and result/wait contract before dispatch. Task Group separately uses public `ToolInfo.description` markers to determine whether Eval wrappers recognize its exact proc-cancel call; it does not guess from versions. Existing services remain compatible because the active Pool job stays visible in Wait snapshots.

## Envelope behavior

- Grammar: `WS* ompTaskGroup(<strict JSON>) WS* ;? WS* EOF`. Outer whitespace and one optional terminal semicolon are allowed; nothing else. No arbitrary JavaScript.
- Valid envelope → `tool_call` rewrites the input to a compiled native Eval program; `tool_result` decodes JSON views and finalizes stable details (`{ protocol: "omp-task-group/v1", snapshot, gate, ... }`).
- Recognized-but-malformed envelope → `{ block: true, reason }`; it is never executed as ordinary JavaScript.
- `background: "require"` / `execution.mode: "background"` is accepted only when the plan resolves to `pool` (homogeneous `join=all + failure=collect`, `concurrency=auto`, no per-task schema/isolation, compact/structured output, pool enabled, not explicit fanout). The numeric threshold is not applied and the path does not read `eval.autoBackground`; a non-pool plan is blocked before compilation with the plan reasons. The dispatch/collect cells must complete synchronously: a host config that backgrounds every eval (`enabled=true`, `thresholdMs=0`) makes dispatch unconfirmed and fail closed. `background: "auto"` / `"foreground"` and `execution.mode: "auto"` / `"foreground"` compile to one foreground cell. Combining explicit foreground and explicit background values is a schema error. Both phases reject `reset:true`.
- `ompTaskGroupCollect({"groupId","resultId"})` is a second strict envelope (same grammar; exactly those two keys, no path). It is recognized and compiled only for a registered session record whose group id matches; it runs in the eval kernel that retains the handle.
- Non-envelope Eval calls are untouched and are not claimed as plugin-owned.
- `tool_result` reports native Eval errors explicitly. For a foreground group or a background dispatch cell, `details.async` is a barrier/protocol violation and never success: the result is replaced with an explicit error and the plugin does not cancel the host-owned job. For a dispatch cell, the record is kept so a handle that did run can still be collected. Collect `details.async` is also an explicit error.

## Eval result limits and backgrounding

- OMP Eval exposes `console.log()` but no `display()` global.
- A completed foreground Eval result uses one `details.cells[]` entry; JSON views carry structured values at `cells[].views[].view.value`.
- Current OMP retains at most 16 JSON views per cell and drops a view whose serialized JSON exceeds 32 KiB. The compiler emits 14,000-character chunks and fails closed beyond 16 chunks.
- Native Eval auto-backgrounding exists on OMP 18.16.0, but the plugin does not use it as a delivery path. For explicit background groups:
  - the dispatch cell creates a named Workpool, pushes once, verifies one unique item id per task, retains the handle/ids in the Eval kernel global, and returns one receipt view (`details.background.state="dispatched"`, `delivery="workpool-async"`, `itemIds`, `itemCount`, result id, planned path); it never calls `wait()` and prints no result text;
  - `details.async` on the dispatch cell is never success: dispatch is unconfirmed, the record is kept for a later collect, and tasks are not rerun;
  - OMP's later `async-result` notice is an ungated text preview, not the Task Group result;
  - the model runs `ompTaskGroupCollect({"groupId","resultId"})` in the same kernel after the notice. The collect cell calls only `status()`/`peek()`, reports `pending` while the pool is not drained, and never waits or consumes another job;
  - a drained snapshot is strictly decoded and gated by the shared in-cell Result Gate; the collect cell writes one atomic wrapper file in a session-private `0700` temp directory (file `0600`, temp + fsync + rename, SHA-256 over the exact payload JSON);
  - `task_group_result` verifies the file, runs the same exact-coverage decoder, and serves the in-cell gate text in 4000-character segments; `consume` deletes only that registered file after full delivery.
- A collect can report `state="failed"` with stage `handle`/`state`/`decode`/`write`; none writes a trusted file. A kernel reset or session change loses the retained handle. Collect is safe to repeat while pending.
- Cancellation uses the ordinary write tool on `proc://<groupId>/kill`, which cascades to pool items. A readable snapshot yields a drained `cancelled` group and a gated file; a destroyed pool produces an explicit state/handle failure and no file. OMP may send no async-result notice after cancellation. Reads return `pending` until collect writes a file or the two-hour pending deadline/session cleanup, never success. An observed, unconsumed result file expires after `background.retentionMinutes` without access or delivery progress (default 30 minutes, range 1–1440; access renews only while unexpired; expired results are reclaimed, not revived); a partially delivered result is kept until read completion or session cleanup.
- The foreground `eval.autoBackground` scan is best effort. It blocks a known-enabled foreground group or an unreadable higher-precedence layer; the two-phase background path does not read it. OMP exposes no public effective-settings API; the runtime `details.async` signal remains authoritative for foreground/dispatch cells.

## Deliberate non-dependencies

- No `@oh-my-pi/*` imports at runtime; OMP-facing types are handwritten in `src/types.ts`.
- No private Workpool, AgentRegistry, AsyncJobManager, or Eval bridge imports.
- No OMP settings mutation.
- No `registerTool("eval")` and no `ctx.invokeTool`; native Eval is never shadowed.

## Remaining limits

DAG / pipeline / loop / switch / `depends_on` / resume belong to OMP Swarm. A single delegated job belongs to native `task`. Task Group has no live per-task update stream; status lines are coarse Eval phases, not a result channel. Background execution is supported only as the explicit two-phase Workpool opt-in: it requires a pool-eligible homogeneous `all + collect` spec, the dispatch cell returns only verified push ids (never a result), OMP's native async-result preview is not the result, and the model must run `ompTaskGroupCollect` and then `task_group_result` to read and consume the gated file. A kernel reset or session change loses the retained handle; collect fails closed. A cancelled pool may produce no notice and yields either a drained `cancelled` group or an explicit failure, never a fabricated result. A foreground group that is unexpectedly backgrounded still fails closed without cancelling the host job.

## Background surface dependencies

The background contract relies only on documented public surfaces:

- the native Eval prelude's `workpool(agent, {name, context, tools})` with async `push`, `status`, `peek`, and `close`, plus the Eval kernel's persistent globals for the retained handle;
- OMP's documented `async-result` delivery as the completion hint (never as the payload);
- the ordinary `write` tool on `proc://<groupId>/kill` for cancellation, including its cascade to pool items;
- the native Eval prelude's `fs` and `Bun` globals (Eval itself is exec-approved) for the atomic collect file write and SHA-256;
- a registered extension tool (`task_group_result`, approval `read`) for verified segmented reads and explicit consume, including the non-error receipt for a repeated consume of an id already consumed in the session;
- Node's built-in `fs`, `os`, `path`, and `crypto` modules in the extension host for directory creation, ownership/mode checks, and host-side checksum verification.

It does not import private Workpool/async-job APIs, poll background jobs, register a second completion notification, invoke `wait()` from collect, or mutate user settings. If a future OMP release changes the Eval globals, Workpool snapshot shape, or async-result timing, the failure mode is an explicit pending/failed collect or a missing result file, never a fabricated success.
