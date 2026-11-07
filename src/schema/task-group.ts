/**
 * omp-task-group — Task Group specification schema.
 *
 * The internal protocol is deliberately workflow-free: no steps, no depends_on,
 * no waits_for, no next, no pipeline, no loop, no switch. A Task Group is ONE
 * atomic fan-out/join batch. Multi-stage work belongs to OMP Swarm.
 */

export type JoinMode = "all" | "any" | "quorum";
export type FailureMode = "collect" | "fail_fast";
export type Strategy = "auto" | "fanout" | "pool";
export type OutputMode = "compact" | "structured" | "summarize";
/**
 * Background policy. `auto` and `foreground` execute one foreground cell.
 * `require` is the explicit two-phase Workpool background opt-in: the dispatch
 * cell returns after a verified `push()`, and an explicit collect cell later
 * writes the checksummed result file read with `task_group_result`.
 */
export type BackgroundMode = "auto" | "foreground" | "require";
/**
 * Execution-mode policy. `background` is the explicit background opt-in with
 * the same two-phase Workpool delivery as `background: "require"`.
 */
export type ExecutionMode = "auto" | "foreground" | "background";

export interface TaskGroupTask {
  /** Stable identifier; becomes part of the child agent label. */
  name: string;
  /** OMP agent name (task/scout/reviewer/security-reviewer/sonic/user-defined). */
  agent: string;
  /** Full task prompt handed to the child. */
  task: string;
  /** Coarse effort hint; only forwarded when the host exposes it. */
  effort?: "lo" | "med" | "hi";
  /** JSON Schema for structured output (Result Gate: structured mode). */
  schema?: Record<string, unknown>;
  schemaMode?: "permissive" | "strict";
  /** Run the child in a dedicated worktree. */
  isolated?: boolean;
  /** Kernel tool names the child may call (eval @tool bridge). */
  tools?: string[];
}

export interface TaskGroupJoin {
  mode: JoinMode;
  /** Required when mode = "quorum": 1..N successes settle the group. */
  quorum?: number;
}

export interface TaskGroupFailure {
  mode: FailureMode;
}

export interface TaskGroupExecution {
  strategy: Strategy;
  /** "auto" inherits OMP's own concurrency; integer further caps (never raises). */
  concurrency: "auto" | number;
  /**
   * Background opt-in, mirroring `background`. `background` requests the
   * two-phase Workpool background delivery; `auto` and `foreground` mean one
   * foreground cell.
   */
  mode: ExecutionMode;
}

export interface TaskGroupOutput {
  mode: OutputMode;
  perTaskChars: number;
  maxTotalChars: number;
  preserveHandles: boolean;
}

export interface TaskGroupSpec {
  /** Shared context prepended to every child prompt. */
  context: string;
  /** Short human label used in TUI/RPC surfaces. */
  label?: string;
  /**
   * Background policy. `require` requests the two-phase Workpool background
   * delivery; `auto` and `foreground` stay foreground.
   */
  background: BackgroundMode;
  tasks: TaskGroupTask[];
  join: TaskGroupJoin;
  failure: TaskGroupFailure;
  execution: TaskGroupExecution;
  output: TaskGroupOutput;
  /** Pool thresholds (execution-planner inputs). */
  pool: {
    enabled: "auto" | "off";
    threshold: number;
    fallback: "fanout";
  };
}

export class SpecValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecValidationError";
  }
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/** Shared explanation for contradictory explicit foreground/background policies. */
const BACKGROUND_CONFLICT_REASON =
  'explicit foreground and explicit background policies cannot be combined; use background="require" or execution.mode="background" for the two-phase Workpool background opt-in, or leave both foreground';

/**
 * True when the spec explicitly requests background execution. `auto` stays
 * foreground: background is never inferred from configuration alone.
 */
export function isBackgroundRequested(spec: Pick<TaskGroupSpec, "background" | "execution">): boolean {
  return spec.background === "require" || spec.execution.mode === "background";
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new SpecValidationError(`taskGroup.${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, what: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new SpecValidationError(`taskGroup.${what} must be a string`);
  return value;
}

function asInt(value: unknown, what: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new SpecValidationError(`taskGroup.${what} must be an integer in [${min}, ${max}]`);
  }
  return value;
}


export function validateSpec(raw: unknown): TaskGroupSpec {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SpecValidationError("taskGroup must be an object");
  }
  const root = raw as Record<string, unknown>;

  const context = asString(root.context, "context");
  if (context === undefined || context.trim().length === 0) {
    throw new SpecValidationError("taskGroup.context is required and must be non-empty");
  }

  const backgroundRaw = root.background ?? "auto";
  let background: BackgroundMode;
  if (backgroundRaw === "auto" || backgroundRaw === "foreground" || backgroundRaw === "require") {
    background = backgroundRaw;
  } else {
    throw new SpecValidationError('taskGroup.background must be "auto" | "foreground" | "require"');
  }

  const rawTasks = root.tasks;
  if (!Array.isArray(rawTasks) || rawTasks.length < 2) {
    throw new SpecValidationError(
      "taskGroup.tasks requires at least 2 independent tasks (use the native async task tool for a single delegation)",
    );
  }
  const tasks: TaskGroupTask[] = rawTasks.map((t, i) => {
    const rec = asRecord(t, `tasks[${i}]`);
    const name = asString(rec.name, `tasks[${i}].name`);
    if (name === undefined || !NAME_PATTERN.test(name)) {
      throw new SpecValidationError(
        `taskGroup.tasks[${i}].name must match ${NAME_PATTERN.source} (got: ${JSON.stringify(name)})`,
      );
    }
    const task = asString(rec.task, `tasks[${i}].task`);
    if (task === undefined || task.trim().length === 0) {
      throw new SpecValidationError(`taskGroup.tasks[${i}].task is required and must be non-empty`);
    }
    const agent = asString(rec.agent, `tasks[${i}].agent`) ?? "task";
    const effort = asString(rec.effort, `tasks[${i}].effort`);
    if (effort !== undefined && effort !== "lo" && effort !== "med" && effort !== "hi") {
      throw new SpecValidationError(`taskGroup.tasks[${i}].effort must be "lo" | "med" | "hi"`);
    }
    const schema = asRecord(rec.schema, `tasks[${i}].schema`);
    const out: TaskGroupTask = { name, agent, task };
    if (effort !== undefined) out.effort = effort as TaskGroupTask["effort"];
    if (Object.keys(schema).length > 0) out.schema = schema;
    const schemaMode = asString(rec.schemaMode, `tasks[${i}].schemaMode`);
    if (schemaMode !== undefined) {
      if (schemaMode !== "permissive" && schemaMode !== "strict") {
        throw new SpecValidationError(`taskGroup.tasks[${i}].schemaMode must be "permissive" | "strict"`);
      }
      out.schemaMode = schemaMode;
    }
    if (rec.isolated === true) out.isolated = true;
    if (rec.isolated !== undefined && typeof rec.isolated !== "boolean") {
      throw new SpecValidationError(`taskGroup.tasks[${i}].isolated must be a boolean`);
    }
    if (rec.tools !== undefined) {
      if (
        !Array.isArray(rec.tools) ||
        rec.tools.some((x) => typeof x !== "string")
      ) {
        throw new SpecValidationError(`taskGroup.tasks[${i}].tools must be an array of strings`);
      }
      out.tools = rec.tools.map((x) => x as string);
    }
    return out;
  });

  const names = new Set<string>();
  for (const t of tasks) {
    if (names.has(t.name)) {
      throw new SpecValidationError(`taskGroup.tasks contains duplicate name "${t.name}"`);
    }
    names.add(t.name);
  }

  const joinRec = asRecord(root.join, "join");
  const joinModeRaw = asString(joinRec.mode, "join.mode") ?? "all";
  if (joinModeRaw !== "all" && joinModeRaw !== "any" && joinModeRaw !== "quorum") {
    throw new SpecValidationError('taskGroup.join.mode must be "all" | "any" | "quorum"');
  }
  const join: TaskGroupJoin = { mode: joinModeRaw };
  if (joinModeRaw === "quorum") {
    const quorum = asInt(joinRec.quorum, "join.quorum", 1, tasks.length);
    if (quorum === undefined) {
      throw new SpecValidationError(
        `taskGroup.join.quorum is required when mode is "quorum" (integer in [1, ${tasks.length}])`,
      );
    }
    join.quorum = quorum;
  } else if (joinRec.quorum !== undefined) {
    throw new SpecValidationError('taskGroup.join.quorum is only valid when join.mode is "quorum"');
  }

  const failureRec = asRecord(root.failure, "failure");
  const failureMode = asString(failureRec.mode, "failure.mode") ?? "collect";
  if (failureMode !== "collect" && failureMode !== "fail_fast") {
    throw new SpecValidationError('taskGroup.failure.mode must be "collect" | "fail_fast"');
  }

  const execRec = asRecord(root.execution, "execution");
  const strategy = asString(execRec.strategy, "execution.strategy") ?? "auto";
  if (strategy !== "auto" && strategy !== "fanout" && strategy !== "pool") {
    throw new SpecValidationError('taskGroup.execution.strategy must be "auto" | "fanout" | "pool"');
  }
  const concurrencyRaw = execRec.concurrency ?? "auto";
  let concurrency: TaskGroupExecution["concurrency"] = "auto";
  if (concurrencyRaw !== "auto") {
    const c = asInt(concurrencyRaw, "execution.concurrency", 1, 32);
    if (c === undefined) {
      throw new SpecValidationError('taskGroup.execution.concurrency must be "auto" or an integer in [1, 32]');
    }
    concurrency = c;
  }

  const executionModeRaw = execRec.mode ?? "auto";
  let executionMode: ExecutionMode;
  if (executionModeRaw === "auto" || executionModeRaw === "foreground" || executionModeRaw === "background") {
    executionMode = executionModeRaw;
  } else {
    throw new SpecValidationError(
      'taskGroup.execution.mode must be "auto" | "foreground" | "background"',
    );
  }
  if (background === "require" && executionMode === "foreground") {
    throw new SpecValidationError(`taskGroup.background="require" conflicts with execution.mode="foreground": ${BACKGROUND_CONFLICT_REASON}`);
  }
  if (background === "foreground" && executionMode === "background") {
    throw new SpecValidationError(`taskGroup.background="foreground" conflicts with execution.mode="background": ${BACKGROUND_CONFLICT_REASON}`);
  }

  const outputRec = asRecord(root.output, "output");
  const outputMode = asString(outputRec.mode, "output.mode") ?? "compact";
  if (outputMode !== "compact" && outputMode !== "structured" && outputMode !== "summarize") {
    throw new SpecValidationError('taskGroup.output.mode must be "compact" | "structured" | "summarize"');
  }
  const perTaskChars = asInt(outputRec.perTaskChars, "output.perTaskChars", 100, 20000) ?? 1200;
  const maxTotalChars = asInt(outputRec.maxTotalChars, "output.maxTotalChars", 500, 100000) ?? 8000;
  if (maxTotalChars < perTaskChars) {
    throw new SpecValidationError("taskGroup.output.maxTotalChars must be >= output.perTaskChars");
  }
  const preserveHandles = outputRec.preserveHandles === undefined ? true : outputRec.preserveHandles === true;

  const poolRec = asRecord(root.pool, "pool");
  const poolEnabledRaw = asString(poolRec.enabled, "pool.enabled") ?? "auto";
  if (poolEnabledRaw !== "auto" && poolEnabledRaw !== "off") {
    throw new SpecValidationError('taskGroup.pool.enabled must be "auto" | "off"');
  }
  const poolThreshold = asInt(poolRec.threshold, "pool.threshold", 2, 200) ?? 6;
  const poolFallback = asString(poolRec.fallback, "pool.fallback") ?? "fanout";
  if (poolFallback !== "fanout") {
    throw new SpecValidationError('taskGroup.pool.fallback must be "fanout"');
  }

  return {
    context,
    label: asString(root.label, "label") ?? undefined,
    background,
    tasks,
    join,
    failure: { mode: failureMode },
    execution: { strategy, concurrency, mode: executionMode },
    output: { mode: outputMode, perTaskChars, maxTotalChars, preserveHandles },
    pool: { enabled: poolEnabledRaw, threshold: poolThreshold, fallback: poolFallback },
  };
}
