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
│   ONLY public prelude: agent / wait / workpool /           │
│   completion / console.log / phase / tool.hub              │
└────────────────────────────────────────────────────────────┘
│ RESULT GATE (src/result)   bound the delivered bytes       │
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

OMP v18.12 retains at most 16 JSON views per cell and drops a view over 32 KiB.
The compiler emits 14,000-character chunks; results requiring more than 16
chunks produce a fail-closed size error instead of a partial result.

There is no custom live-update stream, RPC snapshot channel, or widget. The
`console.log()` JSON views are ordinary cell output used only for final result
transport; they do not carry live per-task progress.


## Why the parent sees exactly one delivery

1. The whole fan-out/join executes **inside one native eval cell**: children are
   `agent()`-spawned with unique labels (`<groupId>-<task>`), and each handle gets
   exactly one wait, consumed exactly once when it settles — so child async-job
   deliveries are consumed in-cell and never re-deliver to the parent.
2. Early-exit joins (`any`, `quorum`, `fail_fast`) cancel pending children and
   reap their waits (3s gate), so cancelled children never re-deliver either.
3. One native eval result, finalized by the `tool_result` hook, is the only
   continuation the parent receives.

## Envelope grammar

- Exactly one `ompTaskGroup(<strict JSON>)` call; argument is strict JSON
  (double-quoted keys, no comments, no trailing commas). No arbitrary JavaScript.
- A valid envelope must be distinguishable from a non-envelope, and a
  recognized-but-malformed envelope must be distinguishable from both (blocked
  with a reason, never silently run as a normal cell).

## Compiler invariants

- Spec embeds as JSON inside the rewritten cell — no escaping holes.
- The compiled program uses only OMP's public eval prelude and sends the
  `omp-task-group/eval-result-v1` payload through JSON-view chunks.
- Each chunk is 14,000 characters or less; at most 16 chunks fit one eval cell.
- Per-task output is clipped before transport. No `import` / `require` /
  `process` appears in the generated program.
- Join semantics:
  - `all + collect` → race until every child settles, no early exit
  - `all + fail_fast` → first failure cancels the rest
  - `any` / `quorum` → condition satisfied cancels the rest
- Pool only for `all + collect` homogeneous batches.
- `Promise.withResolvers()` for the reap gate (3s), `setTimeout` contained.

## Finalizer invariants (eval-result)

- `decodeEvalGroupResult(details, spec, expectedGroupId)` reads native
  `details.cells[].views[].view.value`; missing, foreign, duplicate, incomplete,
  malformed, or oversized chunks fail closed.
- The decoder validates the inner protocol/group id, result shape, task names,
  and statuses. A `details.async` result remains a foreground-barrier violation.
- Final details always use the stable snapshot shape
  (`omp-task-group/v1`); raw eval views never leak to the caller.

## Barrier discipline

Task Group requires a foreground native eval cell.
- A **configured** auto-background (`eval.autoBackground.enabled=true`,
  documented key) is a hard block: the plugin refuses to run envelope groups and
  says how to fix it. No degraded opt-in exists.
- A **steering-triggered** auto-background cannot be pre-blocked; if it happens
  anyway, the native result carries `details.async` and the group is decoded as a
  barrier violation — detected and fail-closed, never hidden, no immunity
  promised.
- The plugin never mutates user settings.

## Public API discipline

`src/types.ts` reproduces documented contracts only (docs/extensions.md,
docs/tools/eval.md, docs/tools/hub.md, docs/tui.md). The check is enforced twice:
`scripts/check-private-imports.ts` (CI) and `tests/unit/private-api.test.ts`.
No `@oh-my-pi/*` runtime imports anywhere — the host's bundled copy is never
reached through module graphs.
