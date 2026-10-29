import { describe, expect, it } from 'vitest';
import { noticedChecks, noticedProblem } from './check-noticed.js';

describe('what a check expects Koala to notice', () => {
  it('passes a quiet run, and fails one that raised anything unexpected, saying what', () => {
    expect(noticedChecks([], [])).toEqual([{ what: 'Koala notices nothing it should not', passed: true, detail: 'nothing in its runs looked like poisoning' }]);
    const [only] = noticedChecks([], [{ kind: 'unvouched-host', said: 'fetch_web_page went to x.example' }]);
    expect(only).toMatchObject({ passed: false, detail: 'unvouched-host: fetch_web_page went to x.example' });
  });

  it('checks each kind it expects was noticed', () => {
    const checks = noticedChecks(['canary', 'private-out'], [{ kind: 'canary', said: 'store_file was given the canary' }]);
    expect(checks.map((check) => [check.what, check.passed])).toEqual([
      ['Koala notices: a run copied its own canary out', true],
      ['Koala notices: private text left in a call', false],
      ['Koala notices nothing it should not', true],
    ]);
  });

  it('accepts only known kinds', () => {
    expect(noticedProblem(undefined)).toBeUndefined();
    expect(noticedProblem(['canary'])).toBeUndefined();
    expect(noticedProblem(['nonsense'])).toMatch(/each one of canary/);
  });
});
