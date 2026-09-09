/**
 * omp-task-group — Missed Group Detector.
 *
 * Post-hoc telemetry only: when the main agent issues MULTIPLE async `task`
 * calls within one turn with no dependency signal between them, record a
 * missed_group_candidate. No monkey patching, no rewriting of issued tool
 * calls, no private batch metadata. (Pre-execution guidance comes from the
 * dispatcher policy text.)
 */

import type { TaskGroupConfig } from "../config";

interface PendingCall {
  toolCallId: string;
  intent?: string;
}

export class MissedGroupDetector {
  private pending: PendingCall[] = [];
  private turnActive = false;

  constructor(
    private readonly config: TaskGroupConfig,
    private readonly onCandidate: () => void,
  ) {}

  onTurnStart(): void {
    this.turnActive = true;
    this.pending = [];
  }

  onTurnEnd(): void {
    this.turnActive = false;
    this.pending = [];
  }

  onToolExecutionStart(toolName: string, toolCallId: string, intent?: string): void {
    if (!this.config.telemetry.detectMissedGroups || !this.turnActive) return;
    if (toolName !== "task") return;
    this.pending.push({ toolCallId, intent });
    if (this.pending.length === 2) {
      // First detection for this turn: 2+ independent task calls in one turn.
      this.onCandidate();
    }
  }

  onToolExecutionEnd(toolCallId: string): void {
    this.pending = this.pending.filter((p) => p.toolCallId !== toolCallId);
  }
}
