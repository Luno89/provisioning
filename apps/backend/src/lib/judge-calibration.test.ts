import { describe, it, expect } from 'vitest';
import { calibrate, formatCalibration, type CalibrationRow } from './judge-calibration.js';

const row = (over: Partial<CalibrationRow> = {}): CalibrationRow =>
  ({ id: 'r1', verified: true, verdict: 'sound', ...over });

/** A corpus containing both outcomes, so the base-rate check is meaningful. */
const mixed = (n: number, verdict: any) => [
  ...Array.from({ length: n }, (_, i) => row({ id: `p${i}`, verified: true, verdict })),
  ...Array.from({ length: n }, (_, i) => row({ id: `f${i}`, verified: false, verdict })),
];

describe('the two ways a judge can be wrong', () => {
  it('counts misses — said sound where verification failed', () => {
    // The expensive direction: a wrong approval gets acted on.
    expect(calibrate([row({ verified: false, verdict: 'sound' })]).misses).toBe(1);
  });

  it('counts false alarms — said unsound where verification passed', () => {
    expect(calibrate([row({ verified: true, verdict: 'unsound' })]).falseAlarms).toBe(1);
  });

  it('does not count an abstention as either', () => {
    // "I could not read this" is honest, and treating it as a wrong answer would push a judge
    // towards guessing.
    const out = calibrate([row({ verified: false, verdict: 'unavailable' })]);
    expect(out.misses).toBe(0);
    expect(out.falseAlarms).toBe(0);
    expect(out.unavailable).toBe(1);
  });
});

/**
 * ── THE MOST IMPORTANT CHECK IN THE FILE ──
 * A judge that approves work it was never shown is answering from the task description, or from
 * nothing. That is exactly the harness-v2 failure — its rubric scored a hardcoded diff — detected
 * mechanically rather than by someone happening to look.
 */
describe('the null-input control', () => {
  it('catches a judge that approves evidence it never saw', () => {
    const out = calibrate([
      row({ id: 'a', nullInput: 'sound' }),
      row({ id: 'b', nullInput: 'sound' }),
    ]);
    expect(out.blindApprovals).toBe(2);
    expect(out.warnings[0]).toMatch(/not reading its inputs/);
  });

  it('says the rest of the report is void when that happens', () => {
    // If it approves work it was not shown, agreement elsewhere is a coincidence of the corpus.
    const out = calibrate([row({ nullInput: 'sound' })]);
    expect(out.warnings[0]).toMatch(/no other number in this report means anything/);
  });

  it('is happy when the judge abstains without evidence', () => {
    const out = calibrate([row({ nullInput: 'unavailable' }), row({ id: 'b', nullInput: 'unsound' })]);
    expect(out.blindApprovals).toBe(0);
    expect(out.warnings).toHaveLength(0);
  });
});

describe('stability', () => {
  it('catches a verdict that flips on an identical re-score', () => {
    // A verdict that changes for the same input is noise wearing a word, whatever its accuracy.
    const out = calibrate([
      row({ id: 'a', verdict: 'sound', repeat: 'unsound' }),
      row({ id: 'b', verdict: 'sound', repeat: 'unsound' }),
    ]);
    expect(out.unstable).toBe(2);
    expect(out.warnings.some((w) => /noise/.test(w))).toBe(true);
  });

  it('is quiet when it agrees with itself', () => {
    const out = calibrate([row({ verdict: 'sound', repeat: 'sound' })]);
    expect(out.unstable).toBe(0);
  });
});

/**
 * Accuracy on a skewed corpus is exactly the number a constant-output judge scores well on, so the
 * distribution is reported instead — and a constant is caught by its own base rate.
 */
describe('base rates, which catch the agreeable judge', () => {
  it('catches a judge that says sound to everything', () => {
    const out = calibrate(mixed(20, 'sound'));
    expect(out.warnings.some((w) => /that is a constant, not a judgement/.test(w))).toBe(true);
  });

  it('catches one that says unsound to everything too', () => {
    // A judge that always complains is not being careful, it is being useless.
    expect(calibrate(mixed(20, 'unsound')).warnings.some((w) => /constant/.test(w))).toBe(true);
  });

  it('does NOT cry constant on a corpus where everything really did pass', () => {
    // Nothing can distinguish a good judge from an agreeable one without both outcomes present.
    const allPassing = Array.from({ length: 20 }, (_, i) => row({ id: `p${i}`, verified: true, verdict: 'sound' }));
    expect(calibrate(allPassing).warnings.some((w) => /constant/.test(w))).toBe(false);
  });

  it('is quiet about a judge that discriminates', () => {
    const out = calibrate([
      ...Array.from({ length: 10 }, (_, i) => row({ id: `p${i}`, verified: true, verdict: 'sound' })),
      ...Array.from({ length: 10 }, (_, i) => row({ id: `f${i}`, verified: false, verdict: 'unsound' })),
    ]);
    expect(out.warnings).toHaveLength(0);
  });
});

describe('the report someone actually reads', () => {
  it('leads with the worst problem', () => {
    const out = calibrate([row({ verified: false, verdict: 'sound', nullInput: 'sound' })]);
    // Blind approval outranks a miss, because it explains it.
    expect(out.warnings[0]).toMatch(/not reading its inputs/);
  });

  it('says so plainly when nothing is wrong', () => {
    expect(formatCalibration(calibrate([row({ repeat: 'sound', nullInput: 'unavailable' })]))).toContain('No warnings.');
  });

  it('survives an empty corpus', () => {
    const out = calibrate([]);
    expect(out.scored).toBe(0);
    expect(out.warnings).toHaveLength(0);
    expect(formatCalibration(out)).toContain('Scored 0 runs');
  });
});
