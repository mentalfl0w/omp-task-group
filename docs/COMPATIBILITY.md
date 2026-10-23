# omp-task-group — Compatibility

Target: OMP (oh-my-pi) v18.12.1 — eval contract source: `docs/tools/eval.md`
and `packages/coding-agent/src/eval/js/shared/runtime.ts` at tag v18.12.1 of
can1357/oh-my-pi.

## Public surfaces consumed

| Surface | Contract | Guard |
| --- | --- | --- |
| Extension factory | default export `(pi: ExtensionAPI)` | load crash → host skips plugin |
| `pi.on("tool_call")` returning `{ input }` | rewrites valid envelope input | input is revalidated by the active eval owner |
| `pi.on("tool_call")` returning `{ block, reason }` | blocks a recognized malformed envelope | never executes it as ordinary JS |
| `pi.on("tool_result")` returning a patch | replaces final content/details/isError | only after exact wire-protocol decode |
| native eval JSON views | `console.log()` JSON values at `details.cells[].views[].view.value` | exact protocol, transport, group id, and complete chunk coverage |
| `before_agent_start` return `{systemPrompt}` | REPLACE system prompt | Array.isArray guard |
| `ctx.ui.notify(text, level?)` | notification string | `/task-group` command only |
| `ctx.abort()` | abort current operation | collision at tool execution start |
| eval prelude `agent/wait/completion/workpool/console.log/phase/tool.hub` | documented helpers | no private runtime import |
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
  group program; `tool_result` decodes OMP JSON views and finalizes the result
  with stable snapshot details (`{ protocol: "omp-task-group/v1", snapshot, gate, ... }`).
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

## Current eval result contract (OMP v18.12.1)

- JavaScript eval exposes `console.log()` but no `display()` global.
- The eval result uses `details.cells[]`; JSON views carry structured values at
  `cells[].views[].view.value`.
- OMP retains at most 16 JSON views per cell and drops a view over 32 KiB.
  The compiler emits 14,000-character chunks and fails closed beyond 16 chunks.
- `details.async` marks a steering-triggered auto-background; Task Group rejects
  it because the result is not final.

## Historical live integration evidence (OMP v18.1.x)

- `wait()` consumed child deliveries in-cell; workpool aggregate delivery was
  recovered exactly once via `hub wait`.
- A 10-child live group produced one continuation and zero child wakes.
- `agent()` preflight errors threw synchronously; unknown agents failed fast.
- Handle `.status` was a property in Python and a function in JavaScript;
  `.done()` was promise-like.
- These live observations were collected on v18.1.x; the current wire transport
  is based on the v18.12.1 eval contract above.

## Not supported (non-goals)

DAG / pipeline / loop / switch / depends_on / next / resume — use swarm.
Single delegated job — use native `task`. Live per-task updates while a group
runs — the parent sees one final native eval result (ordinary cell phase output is
not a Task Group update channel).
