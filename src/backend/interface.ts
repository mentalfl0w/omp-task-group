/**
 * omp-task-group — backend abstraction.
 *
 * The engine (planner/join/result-gate/telemetry) depends only on this
 * interface. The standard-eval envelope hook compiles and runs the group,
 * then supplies its validated eval result through this seam. If OMP later
 * ships a public ctx.agents spawn/join surface, a live backend can be added
 * without changing engine/result-gate behavior.
 */

import type { TaskGroupSpec } from "../schema/task-group";
import type { GroupEvent, TaskGroupSnapshot } from "../state/events";

export interface BackendCapabilities {
  fanout: boolean;
  workpool: boolean;
  summarize: boolean;
  structured: boolean;
  joinAll: boolean;
  joinAny: boolean;
  joinQuorum: boolean;
  rpcUi: boolean;
  /** Why specific capabilities are unavailable (for /task-group explain). */
  notes: string[];
}

export interface BackendRunCallbacks {
  /** Raw runtime events; feed the snapshot reducer. */
  onEvent(event: GroupEvent): void;
  /** Opaque progress text lines for live TUI/RPC updates (pre-throttle). */
  onProgressLine(line: string): void;
}

export interface TaskOutcome {
  name: string;
  agent: string;
  status: "succeeded" | "failed" | "cancelled" | "missing";
  /** agent:// handle of the child (full transcript). */
  handle?: string;
  durationMs?: number;
  resolvedModel?: string;
  /** Child result text, already truncated to perTaskChars by the program. */
  result?: string;
  /** Parsed structured output when the child had a schema. */
  structured?: unknown;
  error?: string;
  tokens?: number | null;
}

export interface GroupRunResult {
  groupId: string;
  strategy: "fanout" | "pool";
  fallbackReason?: string;
  outcomes: TaskOutcome[];
  /** Character count of raw child output that passed through the program. */
  rawChildChars: number;
  /** Set when the group ended abnormally (join exhausted etc.). */
  groupError?: string;
  cancelled?: boolean;
  /** Strict-barrier was violated at runtime (auto-background engaged). */
  barrierViolated?: string;
  /** Compressed digest when output.mode=summarize succeeded. */
  summary?: string;
}

export interface TaskGroupBackend {
  capabilities(): BackendCapabilities;
  runGroup(
    spec: TaskGroupSpec,
    groupId: string,
    strategy: "fanout" | "pool",
    callbacks: BackendRunCallbacks,
    signal: AbortSignal | undefined,
  ): Promise<GroupRunResult>;
}
