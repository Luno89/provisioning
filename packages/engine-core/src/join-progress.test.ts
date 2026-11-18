import { describe, expect, it } from 'vitest';
import { JOIN_PROGRESS_CASES, joinProgressCredential, joinProgressOf, JOIN_PROGRESS_PATH } from './join-progress.js';

describe('a machine\'s join progress, as root hears it', () => {
  it('is posted to one path with the join code as its credential', () => {
    expect(JOIN_PROGRESS_PATH).toBe('/api/machines/join-progress');
    expect(joinProgressCredential('the-code')).toEqual({ authorization: 'Bearer the-code' });
  });

  it('takes a stage, its title and its state, and a failure with why', () => {
    expect(joinProgressOf({ stage: 'k3s', title: 'Installing k3s', state: 'started' })).toEqual({ ok: true, value: { stage: 'k3s', title: 'Installing k3s', state: 'started' } });
    expect(joinProgressOf({ stage: 'k3s', title: 'Installing k3s', state: 'failed', why: 'the disk is full' })).toEqual({ ok: true, value: { stage: 'k3s', title: 'Installing k3s', state: 'failed', why: 'the disk is full' } });
  });

  it('refuses anything else, saying what is wrong, so nothing a step printed can ride along', () => {
    for (const { body, problem } of JOIN_PROGRESS_CASES.refused) expect(joinProgressOf(body)).toEqual({ ok: false, problem });
    for (const body of JOIN_PROGRESS_CASES.accepted) expect(joinProgressOf(body)).toMatchObject({ ok: true });
  });
});
