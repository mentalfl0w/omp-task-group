# omp-task-group — Compatibility

Audit target: current upstream `can1357/oh-my-pi` main, `@oh-my-pi/pi-coding-agent` v18.16.0, audited on 2026-11-03. Live integration ran against local OMP v18.14.1. Runtime compatibility is checked from public Eval/tool results; the plugin does not guess from OMP version strings.

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
| `ctx.ui.notify(text, level?)` | notification text | `/task-group` command only |
| `ctx.abort()` | aborts a colliding rewritten Eval | called before the replaced code runs |
| session entries via `pi.appendEntry` | telemetry persistence | package-qualified custom type |
| `ctx.sessionManager.getBranch()` | read-only branch | telemetry rehydrate |

Task Group does not register or shadow `eval` and does not use `ctx.invokeTool`.
Ordinary Eval remains native; Smart Approve and other Eval interceptors see the
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

Each Pool item prompt requires exactly one `yield` call with its 1-based item key. Success uses `data: { status: "succeeded", value }`; failure uses the `error` field. OMP's current Workpool implementation assembles these yields into each `peek().batches[].output` JSON object, keyed by the IDs returned from `pool.push()`. Task Group maps by those IDs, not by batch order or a guessed item count. A JSON-string-encoded envelope is accepted only if it parses to the exact protocol shape; code fences are never stripped or guessed. It rejects missing/duplicate item identities, duplicate JSON object keys, malformed/truncated JSON, unexpected keys, invalid result envelopes, pending items, and status-count mismatches. The wait is event-driven; after aggregate completion, the plugin checks the complete snapshot and consumes the Workpool aggregate result through `tool.wait()`.

Pool is eligible only for homogeneous `join=all + failure=collect` groups with `execution.concurrency=auto`, no per-task schema, and no per-task isolation. Workpool does not enforce distinct task schemas, isolation, or the Task Group concurrency override. Those groups use Fanout. A runtime preflight or Workpool creation mismatch falls back to Fanout before `push()`; after `push()` is attempted, a thrown error or invalid ID mapping is treated as potentially dispatched, canceled and reaped, then returned as a failure. No post-dispatch failure reruns tasks through Fanout.

The public Pool snapshot does not provide per-item duration or resolved-model metadata. Pool outcomes omit those fields rather than infer or fabricate them. Fanout records local per-handle duration; the current AgentHandle Eval surface does not expose a resolved model to this plugin.

The `/task-group` capability report marks Workpool and Task Group Pool as conditional. The extension context has no public API for inspecting the active Eval prelude, so the generated Eval validates the active Workpool binding and result/wait contract before dispatch. Task Group separately uses public `ToolInfo.description` markers to determine whether Eval wrappers recognize its exact proc-cancel call; it does not guess from versions. Existing services remain compatible because the active Pool job stays visible in Wait snapshots.

## Envelope behavior

- Grammar: `WS* ompTaskGroup(<strict JSON>) WS* ;? WS* EOF`. Outer whitespace and one optional terminal semicolon are allowed; nothing else. No arbitrary JavaScript.
- Valid envelope → `tool_call` rewrites the input to a compiled native Eval program; `tool_result` decodes JSON views and finalizes stable details (`{ protocol: "omp-task-group/v1", snapshot, gate, ... }`).
- Recognized-but-malformed envelope → `{ block: true, reason }`; it is never executed as ordinary JavaScript.
- Non-envelope Eval calls are untouched and are not claimed as plugin-owned.
- `tool_result` reports native Eval errors explicitly. `details.async` remains a foreground-barrier violation.

## Eval result limits and backgrounding

- OMP Eval exposes `console.log()` but no `display()` global.
- A completed Eval result uses one `details.cells[]` entry; JSON views carry structured values at `cells[].views[].view.value`.
- Current OMP retains at most 16 JSON views per cell and drops a view whose serialized JSON exceeds 32 KiB. The compiler emits 14,000-character chunks and fails closed beyond 16 chunks.
- Configured `eval.autoBackground.enabled=true` is blocked for Task Group because the group requires one foreground Eval result. A steering-triggered backgrounding cannot be pre-blocked; the result hook returns an explicit barrier error when `details.async` appears.

## Deliberate non-dependencies

- No `@oh-my-pi/*` imports at runtime; OMP-facing types are handwritten in `src/types.ts`.
- No private Workpool, AgentRegistry, AsyncJobManager, or Eval bridge imports.
- No OMP settings mutation.
- No `registerTool("eval")` and no `ctx.invokeTool`; native Eval is never shadowed.

## Remaining limits

DAG / pipeline / loop / switch / `depends_on` / resume belong to OMP Swarm. A single delegated job belongs to native `task`. Task Group has no live per-task update stream; status lines are coarse Eval phases, not a result channel. If a steering-triggered auto-background occurs after a group has started, OMP owns the asynchronous Eval lifecycle; Task Group reports the barrier violation and attempts to cancel any active Pool, but cannot prevent the host from delivering the backgrounded Eval result.
