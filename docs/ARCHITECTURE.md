# omp-task-group — Architecture

## Layering

```
┌────────────────────────────────────────────────────────────┐
│ src/index.ts            extension wiring (public API only) │
│   ├─ tool_call hook: envelope detect → input rewrite/block │
│   ├─ tool_result hook: finalize via details.jsonOutputs    │
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
│   DISPLAY_PROTOCOL "omp-task-group/eval-result-v1"         │
├────────────────────────────────────────────────────────────┤
│ FINALIZER (src/backend/display-result.ts)                  │
│   decodeDisplayGroupResult: native details.jsonOutputs     │
│   → stable snapshot details (omp-task-group/v1)            │
├────────────────────────────────────────────────────────────┤
│ KERNEL (inside the native eval cell, compiled program)     │
│   ONLY public prelude: agent / wait / workpool /           │
│   completion / display / print / tool.hub                  │
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
2. **`tool_result` (finalization).** The compiled program calls `display()` exactly
   once with the wire payload (`protocol: "omp-task-group/eval-result-v1"`, group
   id, strategy, group state, clipped per-task outcomes, optional group/summary
   error). OMP stores the full display value in native `details.jsonOutputs`;
   `decodeDisplayGroupResult(details, spec, expectedGroupId)` selects the exact
   protocol + group id, validates result shape / task names / statuses, and folds
   the outcome set back into the **stable snapshot details** —
   `{ protocol: "omp-task-group/v1", snapshot, gate, ... }`. The tool result is
   finalized with the bounded digest text as content and that snapshot as details.

There is no custom live-update transport: no `@@TG_*` stdout markers, no streamed
RPC snapshot channel, no widget updates. Output lines the native eval cell happens
to show while a group runs are ordinary cell output, not Task Group transport.

## Why the parent sees exactly one delivery

1. The whole fan-out/join executes **inside one native eval cell**: children are
   `agent()`-spawned with unique labels (`<groupId>-<task>`), and each handle gets
   exactly one wait, consumed exactly once when it settles — so child async-job
   deliveries are consumed in-cell and never re-deliver to the parent.
2. Early-exit joins (`any`, `quorum`, `fail_fast`) cancel pending children and
   reap their waits (3s gate), so cancelled children never re-deliver either.
3. The single `display()` call is the only thing the parent sees: one native eval
   tool result, finalized by the `tool_result` hook.

## Envelope grammar

- Exactly one `ompTaskGroup(<strict JSON>)` call; argument is strict JSON
  (double-quoted keys, no comments, no trailing commas). No arbitrary JavaScript.
- A valid envelope must be distinguishable from a non-envelope, and a
  recognized-but-malformed envelope must be distinguishable from both (blocked
  with a reason, never silently run as a normal cell).

## Compiler invariants

- Spec embeds as JSON inside the rewritten cell — no escaping holes.
- The compiled program uses only the public eval prelude and calls `display()`
  exactly once with the `omp-task-group/eval-result-v1` payload
  (`{ protocol, groupId, strategy, groupState, rawChildChars, outcomes,
  groupError?, summary?, summaryError? }`).
- Outcomes carry `name`, `agent`, settled `status`, and optionally `handle`,
  `durationMs`, `resolvedModel`, clipped `result`, `structured`, `error`.
- Per-task output is clipped before display; the payload is bounded by
  construction. No `import` / `require` / `process` anywhere in the program.
- Join semantics:
  - `all + collect` → race until every child settles, no early exit
  - `all + fail_fast` → first failure cancels the rest
  - `any` / `quorum` → condition satisfied cancels the rest
- Pool only for `all + collect` homogeneous batches.
- `Promise.withResolvers()` for the reap gate (3s), `setTimeout` contained.

## Finalizer invariants (display-result)

- `decodeDisplayGroupResult(details, spec, expectedGroupId)` reads native
  `details.jsonOutputs`; anything missing / foreign / wrong-group-id throws a
  descriptive error rather than guessing.
- Validates result shape, task names against the spec, and statuses; a
  `details.async` native result (steering-triggered auto-background) is decoded
  as a barrier violation — detected and fail-closed, never hidden.
- The finalized details are always the stable snapshot shape
  (`omp-task-group/v1`); raw `jsonOutputs` never leaks to the caller.

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
