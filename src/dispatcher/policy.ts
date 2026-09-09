/**
 * omp-task-group — Smart Dispatcher.
 *
 * Zero additional router inference: a very short routing policy is appended
 * to the main agent's system prompt via the public before_agent_start hook
 * (return { systemPrompt } — documented pattern, same as first-party
 * autoresearch). The dispatcher only ever points at task / task-group /
 * swarm; it never plans multi-stage work itself.
 */

import type { TaskGroupConfig } from "../config";

export const DISPATCH_POLICY = `## Delegation routing (task / task-group / swarm)
Use the async \`task\` tool when:
- there is only ONE delegated job; or
- you have useful independent work to continue while it runs.

Use the standard \`eval\` tool (language "js", timeout 0) with an
\`ompTaskGroup(<strict JSON>)\` envelope in the code when ALL hold:
- 2+ independent jobs in one decision;
- the next meaningful parent decision depends on their COMBINED results;
- no dependency exists between them (one batch, one joined result back).

Use \`swarm\` when later jobs depend on earlier outputs, or when DAG,
pipeline, loop, persistence or resume is required — Task Group is a single
atomic fan-out/join batch, NOT a workflow engine.`;

export function dispatcherEnabled(config: TaskGroupConfig): boolean {
  return config.enabled && config.dispatcher.mode !== "off";
}

/** Compute the replacement system prompt for before_agent_start. */
export function injectPolicy(
  event: { systemPrompt: string[] },
  config: TaskGroupConfig,
): { systemPrompt: string[] } | undefined {
  if (!dispatcherEnabled(config)) return undefined;
  const base = Array.isArray(event.systemPrompt) ? event.systemPrompt : [];
  return { systemPrompt: [...base, DISPATCH_POLICY] };
}
