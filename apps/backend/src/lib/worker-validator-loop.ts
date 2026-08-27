/**
 * worker-validator-loop — orchestrates iterative refinement between worker and validator.
 *
 * ── WHY THIS EXISTS ──
 * An agent given a complex task or existing codebase rarely gets everything 100% right on its
 * very first pass. Previously, a run executed once: if tests or checks failed at the end, the work
 * was simply abandoned on a feature branch with `verified: false`, requiring manual human intervention.
 *
 * This loop pairs the Worker (who writes and modifies code) with the Validator (who executes
 * deterministic validation recipes: commands, probes, file integrity checks). They hand work back
 * and forth iteratively:
 *   1. Worker implements changes in the workspace.
 *   2. Validator evaluates the workspace against the project's ValidationRecipe.
 *   3. If all checks pass: the loop terminates with SUCCESS -> fast-forward merge -> CI/CD build.
 *   4. If checks fail, progress is assessed:
 *      - If meaningful progress was made: the Validator's exact diagnostic report is handed back
 *        to the Worker for round N+1 in the warm workspace.
 *      - If no meaningful progress was made (circling, thrashing, identical failures twice, or budget hit):
 *        the loop circuit-breaker trips, halting execution and preserving diagnostics.
 */

import type { ValidationSummary, ValidationCheckResult } from '../services/UniversalValidatorService.js';

export interface ValidationRoundFailure {
  checkId: string;
  name: string;
  error?: string | undefined;
}

export interface ValidationRoundRecord {
  round: number;
  passed: boolean;
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  failures: ValidationRoundFailure[];
  diagnosticReport: string;
  commits?: number | undefined;
  changedFiles?: string[] | undefined;
}

export interface LoopProgressAssessment {
  shouldContinue: boolean;
  isComplete: boolean;
  reason: string;
  feedbackPrompt?: string | undefined;
}

export const DEFAULT_MAX_VALIDATION_ROUNDS = 4;

export const VALIDATION_DIR = '.validation';
export const VALIDATION_FEEDBACK_FILE = '.validation/feedback.md';
export const VALIDATION_REPORT_FILE = '.validation/report.json';

export interface WorkspaceStorage {
  writeFile(leafId: string, path: string, content: string): Promise<unknown>;
  readFile(leafId: string, path: string): Promise<string>;
}

/**
 * Persists validation feedback and report artifacts into the container at standard locations.
 */
export async function writeValidationArtifacts(
  workspaces: WorkspaceStorage,
  leafId: string,
  summary: ValidationSummary,
  roundRecord: ValidationRoundRecord,
): Promise<void> {
  const feedback = buildFeedbackPrompt(roundRecord);
  const report = JSON.stringify(summary, null, 2);
  await workspaces.writeFile(leafId, `/work/${VALIDATION_FEEDBACK_FILE}`, feedback);
  await workspaces.writeFile(leafId, `/work/${VALIDATION_REPORT_FILE}`, report);
}

/**
 * Reads the latest validation feedback artifact from the container, if present.
 */
export async function readValidationFeedback(
  workspaces: WorkspaceStorage,
  leafId: string,
): Promise<string | undefined> {
  return workspaces.readFile(leafId, `/work/${VALIDATION_FEEDBACK_FILE}`).catch(() => undefined);
}

/**
 * Normalises a failure message for signature comparison across rounds.
 * Strips volatile timestamps and ephemeral port numbers so true identical failures match.
 */
export function failureSignature(failure: ValidationRoundFailure): string {
  const err = (failure.error || '').replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z\b/g, '')
    .replace(/:\d{4,5}\b/g, '')
    .trim();
  return `${failure.checkId}::${err}`;
}

/**
 * Assesses whether the Worker and Validator are making meaningful progress between rounds.
 */
export function assessLoopProgress(
  previousRound: ValidationRoundRecord | undefined,
  currentRound: ValidationRoundRecord,
  maxRounds: number = DEFAULT_MAX_VALIDATION_ROUNDS,
  workerStoppedBecause?: string | undefined,
): LoopProgressAssessment {
  // 1. Success condition: All checks passed
  if (currentRound.passed && currentRound.failedChecks === 0) {
    return {
      shouldContinue: false,
      isComplete: true,
      reason: `All ${currentRound.totalChecks} validation check(s) passed successfully.`,
    };
  }

  // 1b. Worker stopped itself and made zero repository changes: halting
  if (workerStoppedBecause && !currentRound.commits && (!currentRound.changedFiles || currentRound.changedFiles.length === 0)) {
    return {
      shouldContinue: false,
      isComplete: false,
      reason: `Worker stopped (${workerStoppedBecause}) without making repository changes. Halting loop.`,
    };
  }

  // 2. Round ceiling reached
  if (currentRound.round >= maxRounds) {
    return {
      shouldContinue: false,
      isComplete: false,
      reason: `Reached maximum validation rounds (${maxRounds}) with ${currentRound.failedChecks} check(s) still failing.`,
    };
  }

  // 3. First round failure: Always allow at least one refinement iteration if within budget
  if (!previousRound) {
    return {
      shouldContinue: true,
      isComplete: false,
      reason: `Initial validation round completed with ${currentRound.passedChecks}/${currentRound.totalChecks} checks passing. Handing back diagnostics to worker.`,
      feedbackPrompt: buildFeedbackPrompt(currentRound),
    };
  }

  // 4. Progress Signal A: More checks passing than previous round
  if (currentRound.passedChecks > previousRound.passedChecks) {
    return {
      shouldContinue: true,
      isComplete: false,
      reason: `Meaningful progress: Passing checks increased from ${previousRound.passedChecks} to ${currentRound.passedChecks}.`,
      feedbackPrompt: buildFeedbackPrompt(currentRound),
    };
  }

  // 5. Progress Signal B: Fewer checks failing than previous round
  if (currentRound.failedChecks < previousRound.failedChecks) {
    return {
      shouldContinue: true,
      isComplete: false,
      reason: `Meaningful progress: Failing checks decreased from ${previousRound.failedChecks} to ${currentRound.failedChecks}.`,
      feedbackPrompt: buildFeedbackPrompt(currentRound),
    };
  }

  // 6. Stall Detection: Identical failure signatures across rounds
  const prevSigs = new Set(previousRound.failures.map(failureSignature));
  const currSigs = new Set(currentRound.failures.map(failureSignature));
  const signaturesIdentical = prevSigs.size === currSigs.size
    && [...currSigs].every((sig) => prevSigs.has(sig));

  if (signaturesIdentical) {
    // If files also didn't change, worker is definitely stuck
    const prevFiles = (previousRound.changedFiles ?? []).join(',');
    const currFiles = (currentRound.changedFiles ?? []).join(',');
    if (prevFiles === currFiles && (previousRound.commits ?? 0) === (currentRound.commits ?? 0)) {
      return {
        shouldContinue: false,
        isComplete: false,
        reason: `Loop stalled: Worker made no repository changes and the exact same ${currentRound.failedChecks} failure(s) recurred without progress.`,
      };
    }

    // If files changed but the exact same error recurred, allow at most one retry with explicit warning
    if (currentRound.round >= 3) {
      return {
        shouldContinue: false,
        isComplete: false,
        reason: `Loop halted: Repeated identical failure signature across rounds ${previousRound.round} and ${currentRound.round}.`,
      };
    }
  }

  // 7. Regression check: Fewer passing checks than before
  if (currentRound.passedChecks < previousRound.passedChecks) {
    return {
      shouldContinue: true,
      isComplete: false,
      reason: `Warning: Regression detected (${currentRound.passedChecks} passed vs ${previousRound.passedChecks} previously). Handing back for correction.`,
      feedbackPrompt: buildFeedbackPrompt(currentRound, true),
    };
  }

  // Fallback: Continue if within rounds budget
  return {
    shouldContinue: true,
    isComplete: false,
    reason: `Continuing refinement iteration (round ${currentRound.round} of ${maxRounds}).`,
    feedbackPrompt: buildFeedbackPrompt(currentRound),
  };
}

/**
 * Builds the actionable prompt handed back to the worker for the next refinement round.
 */
export function buildFeedbackPrompt(round: ValidationRoundRecord, isRegression = false): string {
  const lines: string[] = [
    `## ⚠️ Validation Feedback (Round ${round.round} of ${DEFAULT_MAX_VALIDATION_ROUNDS})`,
    '',
    isRegression
      ? `**CRITICAL**: A regression occurred in your last change. Only ${round.passedChecks} of ${round.totalChecks} checks are passing.`
      : `Your work was evaluated by the Validator against the project requirements. **${round.passedChecks} of ${round.totalChecks} checks passed.**`,
    '',
    `Please inspect the remaining **${round.failedChecks} failure(s)** below, fix the root causes in the codebase, and verify that they pass:`,
    '',
  ];

  for (const failure of round.failures) {
    lines.push(`### ❌ Check Failed: "${failure.name}" (\`${failure.checkId}\`)`);
    if (failure.error) {
      lines.push('```');
      lines.push(failure.error.slice(0, 2000).trim());
      lines.push('```');
    } else {
      lines.push('*Check failed with no error output.*');
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('**Action Required**: Make the necessary corrections, run any local tests if helpful, and call `finish(succeeded: true)` when ready for re-validation.');

  return lines.join('\n');
}

/**
 * Extracts ValidationRoundRecord from a UniversalValidatorService ValidationSummary.
 */
export function recordFromSummary(
  round: number,
  summary: ValidationSummary,
  repoDetails?: { commits?: number; changedFiles?: string[] },
): ValidationRoundRecord {
  const failures: ValidationRoundFailure[] = summary.checks
    .filter((c: ValidationCheckResult) => !c.passed)
    .map((c: ValidationCheckResult) => ({
      checkId: c.id,
      name: c.name,
      error: c.outputSnippet || c.message,
    }));

  return {
    round,
    passed: summary.passed,
    totalChecks: summary.totalChecks,
    passedChecks: summary.passedChecks,
    failedChecks: summary.failedChecks,
    failures,
    diagnosticReport: summary.diagnosticReport,
    ...(repoDetails?.commits !== undefined ? { commits: repoDetails.commits } : {}),
    ...(repoDetails?.changedFiles !== undefined ? { changedFiles: repoDetails.changedFiles } : {}),
  };
}
