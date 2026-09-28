---
description: Use when planning or executing one batch of two or more independent agent tasks whose results must be combined before the next decision. Covers choosing omp-task-group over task or swarm and invoking its strict eval envelope.
---

# OMP Task Group

Use this playbook to route one independent batch through the `omp-task-group` plugin. It uses OMP's native `eval` tool; it does not add or replace a tool.

## Choose the delegation tool

- Use the async `task` tool for one delegated job, or when you can continue useful independent work while that job runs.
- Use Task Group only when **all** are true: there are at least two independent jobs; they belong to one decision; the next meaningful parent decision needs their combined results; and no job depends on another. Task Group returns one joined result to the parent.
- Use OMP `swarm` when jobs depend on earlier outputs, or the work needs a DAG, pipeline, loop, persistence, or resume.
- Do not put dependent stages in a Task Group or split a single job just to reach two tasks.

## Invoke the Task Group

Call the native `eval` tool with `language: "js"`, `timeout: 0`, and `code` containing exactly one `ompTaskGroup(<strict JSON>)` expression. Outer whitespace and one optional final semicolon are allowed; do not add surrounding JavaScript. The argument must be strict JSON: quote every key and string with double quotes; do not use comments, trailing commas, variables, or JavaScript expressions.

Example eval `code` for two independent review tasks:

```js
ompTaskGroup({
  "context": "Review the authentication change. Return evidence and concise findings.",
  "label": "auth-review",
  "tasks": [
    {
      "name": "auth-flow",
      "agent": "security-reviewer",
      "task": "Inspect authentication and authorization paths for bypasses. Report evidence and severity."
    },
    {
      "name": "test-coverage",
      "agent": "scout",
      "task": "Inspect authentication tests for meaningful coverage gaps. Report missing cases."
    }
  ],
  "join": { "mode": "all" },
  "failure": { "mode": "collect" },
  "execution": { "strategy": "auto", "concurrency": "auto" },
  "output": { "mode": "compact", "perTaskChars": 1200, "maxTotalChars": 8000 }
});
```

Keep each task self-contained and give it a unique name. Put shared context in `context`; put task-specific instructions in each task's `task`. Keep the whole envelope as the eval cell—extra code prevents recognition.

## Settle and format results

- Prefer `join.mode: "all"` when every result informs the decision. Use `"any"` only when the first success is sufficient. Use `"quorum"` only with an explicit success threshold and set `join.quorum`.
- Prefer `failure.mode: "collect"` to retain partial results. Use `"fail_fast"` only when one failure makes the remaining work unnecessary.
- Keep the default `output.mode: "compact"` unless the consumer needs schema-validated structured output. Add a task `schema` when requesting structured output. `summarize` requires the plugin's summarize option to be enabled.
- Leave strategy and concurrency on `"auto"` unless the request has a concrete reason to constrain them.

The group requires a foreground native eval call. If the plugin blocks it because eval auto-background is enabled, report that requirement; do not work around it by running the group in the background or changing the user's settings.
