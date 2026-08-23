/**
 * Finding out whether a judge is reading its inputs, or just sounding like it is.
 *
 * ── WHY A JUDGE NEEDS THIS AND THE DETERMINISTIC LAYERS DO NOT ──
 * An exit code is right or wrong and you can tell which by looking. A model's verdict is fluent
 * either way, and a fluent wrong answer is more dangerous than a blank one because it gets acted on.
 * The abandoned harness-v2 branch shipped a judge whose inputs were literals — every verdict it ever
 * produced was independent of the work — and nothing in that system could have noticed. The point of
 * this file is that something can.
 *
 * ── THE FOUR MEASUREMENTS, AND WHY THE LAST ONE MATTERS MOST ──
 *   1. FALSE ALARMS — said unsound where the tests passed.
 *   2. MISSES — said sound where the tests failed.
 *   3. BASE RATES — what it says regardless. A judge that answers "sound" to everything scores well
 *      on a mostly-passing corpus, and the base rate is the only thing that exposes it. Accuracy
 *      without it is meaningless.
 *   4. THE NULL-INPUT CONTROL — score the same task with the diff replaced by an empty or unrelated
 *      one. A judge that still says "sound" is not reading its inputs, and that is precisely the
 *      harness-v2 failure, detected mechanically rather than by someone happening to look.
 *
 * Plus STABILITY: the same bundle twice. A verdict that flips is noise wearing a word, whatever its
 * accuracy looks like.
 *
 * ── THE HONEST LIMITATION ──
 * Ground truth here is the experiment corpus's verify command, so calibration measures the judge on
 * runs where a deterministic check EXISTS. Live, it runs only where one does not — a different
 * distribution. This establishes that it is not systematically fooled; it cannot establish accuracy
 * on the population it actually serves. The second, slower signal for that is acceptance outcomes:
 * leaves belonging to a request that later failed its acceptance checks are a genuine labelled
 * negative set from production, and recording every verdict beside the eventual outcome costs
 * nothing to collect.
 */
import type { JudgeVerdict } from './leaf-judge.js';

/** One scored run: what the judge said, and what the repository said. */
export interface CalibrationRow {
  id: string;
  /** Ground truth — the verify command's exit code, not anyone's opinion. */
  verified: boolean;
  verdict: JudgeVerdict;
  /** The same bundle scored a second time, when stability was measured. */
  repeat?: JudgeVerdict | undefined;
  /** The same task scored with the evidence removed or replaced. */
  nullInput?: JudgeVerdict | undefined;
}

export interface CalibrationReport {
  scored: number;
  /** Said unsound where verification passed. */
  falseAlarms: number;
  /** Said sound where verification failed. The expensive direction. */
  misses: number;
  /**
   * What it says regardless of the work.
   *
   * Reported as a distribution rather than an accuracy, because accuracy on a skewed corpus is
   * exactly the number a constant-output judge scores well on.
   */
  says: Record<string, number>;
  /** How often it could not answer at all. Not a failure — an honest abstention. */
  unavailable: number;
  /** Of the runs scored twice, how many changed their answer. */
  unstable: number;
  stabilityScored: number;
  /**
   * Of the runs re-scored with the evidence removed, how many still said `sound`.
   *
   * The single most valuable number here. Anything above zero means the judge is answering from the
   * task description, or from nothing.
   */
  blindApprovals: number;
  nullScored: number;
  /** Plain-language findings, worst first. Empty when nothing is wrong. */
  warnings: string[];
}

/** A judge that agrees with itself less often than this is not measuring anything. */
const MAX_UNSTABLE_FRACTION = 0.1;
/** Any blind approval at all is a red flag; this is where it stops being arguable. */
const MAX_BLIND_FRACTION = 0.05;

/**
 * Turns scored rows into the numbers and the warnings.
 *
 * Pure, so the thresholds are testable and the report cannot depend on how it was gathered.
 */
export function calibrate(rows: CalibrationRow[]): CalibrationReport {
  const says: Record<string, number> = {};
  let falseAlarms = 0;
  let misses = 0;
  let unavailable = 0;
  let unstable = 0;
  let stabilityScored = 0;
  let blindApprovals = 0;
  let nullScored = 0;

  for (const row of rows) {
    says[row.verdict] = (says[row.verdict] ?? 0) + 1;
    if (row.verdict === 'unavailable') unavailable++;
    if (row.verified && row.verdict === 'unsound') falseAlarms++;
    if (!row.verified && row.verdict === 'sound') misses++;

    if (row.repeat !== undefined) {
      stabilityScored++;
      if (row.repeat !== row.verdict) unstable++;
    }
    if (row.nullInput !== undefined) {
      nullScored++;
      if (row.nullInput === 'sound') blindApprovals++;
    }
  }

  const warnings: string[] = [];

  /**
   * The null-input control first, because it invalidates everything below it.
   *
   * If the judge approves work it was not shown, its agreement with ground truth elsewhere is a
   * coincidence of the corpus rather than a property of the judge.
   */
  if (nullScored > 0 && blindApprovals / nullScored > MAX_BLIND_FRACTION) {
    warnings.push(
      `Approved ${blindApprovals}/${nullScored} runs whose evidence was removed — it is not reading `
      + 'its inputs, and no other number in this report means anything until that is fixed.',
    );
  }

  if (stabilityScored > 0 && unstable / stabilityScored > MAX_UNSTABLE_FRACTION) {
    warnings.push(
      `Changed its answer on ${unstable}/${stabilityScored} identical re-scores — the verdict is `
      + 'noise. Lower the temperature before reading anything else here.',
    );
  }

  /**
   * A constant judge, caught by its own distribution rather than by its accuracy.
   *
   * Only meaningful with a corpus that actually contains both outcomes; a suite where everything
   * passes cannot distinguish a good judge from a agreeable one.
   */
  const answered = rows.length - unavailable;
  const bothOutcomesPresent = rows.some((r) => r.verified) && rows.some((r) => !r.verified);
  for (const [verdict, n] of Object.entries(says)) {
    if (verdict === 'unavailable' || answered === 0) continue;
    if (bothOutcomesPresent && n / answered > 0.95) {
      warnings.push(
        `Answered "${verdict}" on ${n}/${answered} runs across a corpus containing both outcomes — `
        + 'that is a constant, not a judgement.',
      );
    }
  }

  if (misses > 0) {
    warnings.push(`Called ${misses} run(s) sound that failed verification — the expensive direction.`);
  }
  if (falseAlarms > 0) {
    warnings.push(`Called ${falseAlarms} run(s) unsound that passed verification.`);
  }

  return {
    scored: rows.length,
    falseAlarms,
    misses,
    says,
    unavailable,
    unstable,
    stabilityScored,
    blindApprovals,
    nullScored,
    warnings,
  };
}

/** A short report someone can read in a terminal without decoding it. */
export function formatCalibration(report: CalibrationReport): string {
  const lines = [
    `Scored ${report.scored} runs (${report.unavailable} unavailable).`,
    `  says: ${Object.entries(report.says).map(([k, v]) => `${k}=${v}`).join('  ') || '(nothing)'}`,
    `  misses (said sound, verification failed): ${report.misses}`,
    `  false alarms (said unsound, verification passed): ${report.falseAlarms}`,
  ];
  if (report.stabilityScored) lines.push(`  unstable on re-score: ${report.unstable}/${report.stabilityScored}`);
  if (report.nullScored) lines.push(`  approved with no evidence: ${report.blindApprovals}/${report.nullScored}`);

  if (report.warnings.length) {
    lines.push('', 'Warnings, worst first:', ...report.warnings.map((w) => `  - ${w}`));
  } else {
    lines.push('', 'No warnings.');
  }
  return lines.join('\n');
}
