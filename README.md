# omp-task-group

**Atomic multi-agent coordination for [Oh My Pi (OMP)](https://omp.sh)** — fan out N
independent subagents, join, and return **exactly one logical result** to the parent.
Not a workflow engine: no DAG, no `depends_on`, no pipeline, no loop, no resume.

Targets OMP's documented Eval API audited against v18.16.0. Zero runtime dependencies; public API only.

## What it does

When you delegate 2+ **independent** jobs whose **combined** results drive your next
decision, the naive `task`-per-job pattern amplifies parent wakes: every child
completion is a separate async delivery that interrupts you. omp-task-group fixes that:

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
  "tasks": [
    { "name": "deps",  "agent": "scout",  "task": "Enumerate vulnerable dependencies." },
    { "name": "auth",  "agent": "security-reviewer", "task": "Review auth flows." },
    { "name": "tests", "agent": "scout",  "task": "Report test coverage gaps." }
  ],
  "join":     { "mode": "all" },
  "failure":  { "mode": "collect" },
  "execution": { "strategy": "auto", "concurrency": "auto" },
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

### Join and failure

- `join.mode`: `all` (default) · `any` (first success settles) · `quorum: N`
- `failure.mode`: `collect` (default — report everything, group completes with
  partial successes) · `fail_fast` (first failure cancels the rest)
- Losers of `any`/`quorum`/`fail_fast` are **cancelled and reaped** — their
  deliveries are consumed, nothing leaks to the parent.

### Output modes (Result Gate)

- `compact` — per-task glyph/status, clipped preview, and `agent://` handles.
  Fanout records local per-task duration. The current public Eval API does not
  expose a resolved model per AgentHandle; Workpool also omits per-item duration,
  so those fields are not fabricated.
- `structured` — one JSON aggregate of per-task structured outputs.
- `summarize` — stateless `completion()` digest (opt-in via config), falls back to
  compact on failure.
- Hard caps: `perTaskChars` per task, `maxTotalChars` total. Raw child output is
  **never** concatenated wholesale.

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
  "telemetry": { "enabled": true, "detectMissedGroups": true }
}
```

### Foreground barrier (fail-closed)

Task Group requires a **foreground** native eval cell — the group runs and
finalizes inside that one call. `eval.autoBackground.enabled=true` would hand
long cells to the background job runner and return early, so a *configured*
auto-background is a **hard block**: the plugin detects the documented config key
and refuses to run envelope groups, telling you exactly how to fix it. A
steering-triggered auto-background (a mid-cell steer forcing native
auto-background) cannot be pre-blocked; if it happens anyway, the native result
carries `details.async` and the group is decoded as a barrier violation —
detected and fail-closed, never silently treated as a clean result. The plugin
never mutates user settings, and there is no degraded opt-in.

## RPC / headless

A group is one native eval tool result — there is **no live per-task update
stream** and no custom widget/RPC snapshot channel.

- Content: the bounded text digest — per-task status, clipped preview, duration +
  model, `agent://` handle for the full transcript.
- Details: the final result carries the stable snapshot shape `{ protocol: "omp-task-group/v1", snapshot,
  gate, ... }`. The hook decodes OMP's native `cells[].views[].view.value` transport
  and does not leak the per-cell view chunks.
- Plain/headless and TUI/RPC modes receive identical final content/details.

## Architecture

See `docs/ARCHITECTURE.md`. Highlights:

- **Standard eval envelope**: usage is `eval` code containing exactly
  `ompTaskGroup(<strict JSON>)`. The plugin never shadows `eval`; a `tool_call`
  hook recognizes the envelope (rewriting the cell to run the compiled group
  program) and a `tool_result` hook finalizes the result.
- **Compiled program** uses the public JS eval prelude and emits protocol-tagged
  JSON chunks through `console.log()`. The finalizer reassembles them from
  `details.cells[].views[].view.value` into the stable snapshot details.
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
- A steering-triggered Eval backgrounding cannot be prevented by the extension.
  The result hook reports the foreground-barrier violation and Pool cancellation
  is attempted; OMP still owns delivery of any backgrounded Eval job.
