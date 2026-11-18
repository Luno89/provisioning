import { describe, expect, it } from 'vitest';
import { boundedWhy, JOIN_PROGRESS_CASES, JOIN_PROGRESS_LIMITS, JOIN_PROGRESS_PATH, joinProgressCredential, joinProgressOf } from './machine-join.js';

describe('a machine\'s join progress, as root hears it', () => {
  it('is posted to one path with the join code as its credential', () => {
    expect(JOIN_PROGRESS_PATH).toBe('/api/machines/join-progress');
    expect(joinProgressCredential('the-code')).toEqual({ authorization: 'Bearer the-code' });
  });

  it('takes each accepted case as it was sent', () => {
    for (const body of JOIN_PROGRESS_CASES.accepted) expect(joinProgressOf(body)).toEqual({ ok: true, value: body });
  });

  it('refuses anything else, saying what is wrong, so nothing a step printed can ride along', () => {
    for (const { body, problem } of JOIN_PROGRESS_CASES.refused) expect([body, joinProgressOf(body)]).toEqual([body, { ok: false, problem }]);
  });

  it('shortens a reason longer than root takes, saying it was shortened, and leaves one that fits as it is', () => {
    expect(boundedWhy('the disk is full')).toBe('the disk is full');
    const long = boundedWhy(`${'x'.repeat(JOIN_PROGRESS_LIMITS.why)}tail`);
    expect(long).toHaveLength(JOIN_PROGRESS_LIMITS.why);
    expect(long.endsWith('… (shortened)')).toBe(true);
    expect(joinProgressOf({ stage: 'k3s', title: 'Installing k3s', state: 'failed', why: long }).ok).toBe(true);
  });
});
