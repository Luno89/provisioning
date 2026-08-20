/**
 * Context Manager & Phase Handoff Engine for Harness V2.
 *
 * Implements clean Phase-Driven Context Resets with structured artifacts,
 * completely replacing lossy sliding-window conversation trimming.
 */
import type { TaskPhase, TaskCheckpoint } from '@koala/harness-types';

export interface ContextHandoffDocument {
  phase: TaskPhase;
  turnIndex: number;
  goalSummary: string;
  keyDiscoveries: string[];
  modifiedFiles: string[];
  nextActions: string[];
}

export class ContextManager {
  /**
   * Generates a structured markdown handoff summary for resetting the model's context window.
   */
  static formatHandoffArtifact(doc: ContextHandoffDocument): string {
    return [
      `# Phase Handoff Summary [Phase: ${doc.phase.toUpperCase()}]`,
      `**Checkpoint Turn**: ${doc.turnIndex}`,
      ``,
      `## Goal Summary`,
      doc.goalSummary,
      ``,
      `## Key Discoveries & Environment Facts`,
      doc.keyDiscoveries.length ? doc.keyDiscoveries.map((d) => `- ${d}`).join('\n') : '- None recorded yet.',
      ``,
      `## Modified Workspace Files`,
      doc.modifiedFiles.length ? doc.modifiedFiles.map((f) => `- \`${f}\``).join('\n') : '- No files modified yet.',
      ``,
      `## Immediate Next Actions`,
      doc.nextActions.length ? doc.nextActions.map((a) => `1. ${a}`).join('\n') : '1. Continue task execution.',
    ].join('\n');
  }

  /**
   * Determines whether the active conversation has reached a phase boundary or threshold warranting a context reset.
   */
  static shouldResetContext(turnsInCurrentPhase: number, tokensUsedInPhase: number, thresholdTurns: number = 15): boolean {
    return turnsInCurrentPhase >= thresholdTurns || tokensUsedInPhase >= 40_000;
  }

  /**
   * Assembles a pristine prompt for the new phase seeded with the handoff artifact.
   */
  static assembleResetPrompt(taskTitle: string, taskDescription: string, handoffSummary: string): { role: 'system' | 'user'; content: string }[] {
    return [
      {
        role: 'system',
        content: [
          `You are working on task: "${taskTitle}".`,
          `Task Scope: ${taskDescription}`,
          ``,
          `A context reset has occurred to keep your reasoning sharp. Below is the verified state summary from the previous phase:`,
          ``,
          handoffSummary,
        ].join('\n'),
      },
      {
        role: 'user',
        content: `Resume execution based on the handoff summary. Begin by verifying current workspace state and proceed with the next actions.`,
      },
    ];
  }
}
