import type { CaseOutcome } from './score.js';

export interface Reliability {
  cases: number;
  always: number;
  never: number;
  flaky: number;
}

export function reliability(outcomes: readonly CaseOutcome[]): Reliability {
  return {
    cases: outcomes.length,
    always: outcomes.filter((outcome) => outcome.passed === outcome.attempts).length,
    never: outcomes.filter((outcome) => outcome.passed === 0).length,
    flaky: outcomes.filter((outcome) => outcome.passed > 0 && outcome.passed < outcome.attempts).length,
  };
}
