import type { JudgeVerdict } from './leaf-judge.js';

export interface CalibrationRow {
  id: string;
  verified: boolean;
  verdict: JudgeVerdict;
  repeat?: JudgeVerdict | undefined;
  nullInput?: JudgeVerdict | undefined;
}

export interface CalibrationReport {
  scored: number;
  falseAlarms: number;
  misses: number;
  says: Record<string, number>;
  unavailable: number;
  unstable: number;
  stabilityScored: number;
  blindApprovals: number;
  nullScored: number;
  warnings: string[];
}

const MAX_UNSTABLE_FRACTION = 0.1;
const MAX_BLIND_FRACTION = 0.05;

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
