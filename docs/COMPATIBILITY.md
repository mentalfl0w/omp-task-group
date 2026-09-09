# omp-task-group — Compatibility

Target: OMP (oh-my-pi) v18.1.x — docs sources: `docs/extensions.md`,
`docs/tools/eval.md`, `docs/tools/hub.md`, `docs/tui.md`, `docs/sdk.md`,
`docs/extension-loading.md` at tag v18.1.x of can1357/oh-my-pi.

## Public surfaces consumed

| Surface | Contract | Guard |
| --- | --- | --- |
| Extension factory | default export `(pi: ExtensionAPI)` | load crash → host skips plugin |
| `pi.on("tool_call")` returning `{ input }` | rewrites valid envelope input | input is revalidated by the active eval owner |
| `pi.on("tool_call")` returning `{ block, reason }` | blocks a recognized malformed envelope | never executes it as ordinary JS |
| `pi.on("tool_result")` returning a patch | replaces final content/details/isError | only after exact wire-protocol decode |
| native `details.jsonOutputs` | full `display()` value | sole final result decoder source |
| `before_agent_start` return `{systemPrompt}` | REPLACE system prompt | Array.isArray guard |
| `ctx.ui.notify(text, level?)` | notification string | `/task-group` command only |
| `ctx.abort()` | abort current operation | collision at tool execution start |
| eval prelude `agent/wait/completion/workpool/display/phase/tool.hub` | documented helpers | no private runtime import |
| `workpool` aggregate text format | `- [key] status` + fenced block | tolerant parser + fallback |
| session entries via `pi.appendEntry` | package-qualified type | telemetry persistence |
| `ctx.sessionManager.getBranch()` | read-only branch | telemetry rehydrate |

Not consumed (deliberately): `pi.registerTool` with name `eval`, and
`ctx.invokeTool` — Task Group does **not** shadow eval. `eval` stays the native
built-in for every call, including group cells. That is what makes plugin load
order irrelevant and ordinary-eval approvals (smart-approve) untouched.

## Envelope behavior

- Grammar: `WS* ompTaskGroup(<strict JSON>) WS* ;? WS* EOF`. Outer whitespace and one
  optional terminal semicolon are allowed; nothing else. No arbitrary JavaScript.
- Valid envelope → `tool_call` rewrites the input so the cell runs the compiled
  group program; `tool_result` decodes `details.jsonOutputs` and finalizes the
  result with stable snapshot details
  (`{ protocol: "omp-task-group/v1", snapshot, gate, ... }`).
- Recognized-but-malformed envelope → `{ block: true, reason }`: distinguishable
  from a non-envelope, never executed as ordinary JS.
- Non-envelope eval calls are untouched and are not claimed as plugin-owned.

## Provider quirks handled

- Some function-calling layers add/trim whitespace or append a trailing
  semicolon to code — the grammar tolerates outer whitespace and one terminal
  semicolon.
- Model-generated "JSON" with comments, unquoted keys, or trailing commas is a
  recognized malformed envelope → blocked with a precise reason (never run).
- The same standard eval call form works under both plugin load orders; there is
  no same-name registration whose winner changes by order.

## Deliberate non-dependencies

- No `@oh-my-pi/*` imports at runtime (types hand-written in `src/types.ts`).
- No settings mutation (barrier is fail-closed, never toggles user config).
- No private modules (`task/structured-subagent`, `AsyncJobManager`, …) — guarded.
- No `registerTool("eval")` / `ctx.invokeTool` — native eval is never shadowed.

## Verified empirically / confirmed contracts (OMP v18.1.x)

- eval `wait()` consumes child deliveries in-cell (no re-delivery wake).
- workpool aggregate delivery recovered exactly once via `hub wait`.
- 10-child live group: single continuation, zero child wakes.
- `agent()` preflight errors throw synchronously; unknown agent fails fast.
- handle `.status` is a property (py) / function (js); `.done()` promise-like.
- `display()`'s full value lands in native `details.jsonOutputs`; a native result
  with `details.async` marks a steering-triggered auto-background, which is
  decoded fail-closed as a barrier violation (configured auto-background is a
  hard block; no degraded opt-in).

## Not supported (non-goals)

DAG / pipeline / loop / switch / depends_on / next / resume — use swarm.
Single delegated job — use native `task`. Live per-task updates while a group
runs — the parent sees one final native eval result (ordinary cell phase output is
not a Task Group update channel).
