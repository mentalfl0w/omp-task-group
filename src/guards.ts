/**
 * omp-task-group — canonical runtime type guards.
 *
 * This package has exactly one object guard; import it, never redefine it.
 * (Domain validators in src/schema throw with path context — those are
 * parsers, not guards.)
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
