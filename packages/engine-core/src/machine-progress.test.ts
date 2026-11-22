import { describe, expect, it } from 'vitest';
import { JOIN_PROGRESS, JOIN_PROGRESS_PATH } from './machine-join.js';
import { KOALA_INSTALL_LAST_STAGE, KOALA_INSTALL_PROGRESS, koalaInstallProgressPath } from './koala-install.js';
import { boundedLine, boundedWhy, PROGRESS_LIMITS, progressCases, progressCredential, progressOf } from './machine-progress.js';

describe('a machine\'s progress, as root hears it', () => {
  it('is posted with the machine\'s own credential, a join to one path and each install to its own', () => {
    expect(JOIN_PROGRESS_PATH).toBe('/api/machines/join-progress');
    expect(koalaInstallProgressPath('inst 1')).toBe('/api/machines/koala-installs/inst%201/progress');
    expect(progressCredential('the-code')).toEqual({ authorization: 'Bearer the-code' });
  });

  for (const [name, contract] of [['a join', JOIN_PROGRESS], ['an install of Koala', KOALA_INSTALL_PROGRESS]] as const) {
    it(`takes each accepted case of ${name} as it was sent`, () => {
      for (const body of progressCases(contract).accepted) expect(progressOf(body, contract)).toEqual({ ok: true, value: body });
    });

    it(`refuses anything else for ${name}, saying what is wrong, so nothing a step printed can ride along`, () => {
      for (const { body, problem } of progressCases(contract).refused) expect([body, progressOf(body, contract)]).toEqual([body, { ok: false, problem }]);
    });
  }

  it('lets a join say only its stages, while an install also says what it waits on and, at its end, where Koala answers and the chart revision it put on', () => {
    const waiting = { stage: 'koala', title: 'Putting Koala on this machine', state: 'started', line: 'job/instance-seed-2 runs' };
    expect(progressOf(waiting, JOIN_PROGRESS)).toEqual({ ok: false, problem: 'only "stage", "title", "state" and "why" are taken, not "line"' });
    expect(progressOf(waiting, KOALA_INSTALL_PROGRESS)).toEqual({ ok: true, value: waiting });
    const ended = { stage: KOALA_INSTALL_LAST_STAGE, title: 'Putting Koala on this machine', state: 'done', url: 'https://bo.koala.app', revision: 2 };
    expect(progressOf(ended, KOALA_INSTALL_PROGRESS)).toEqual({ ok: true, value: ended });
    expect(progressOf({ ...ended, url: undefined }, KOALA_INSTALL_PROGRESS)).toMatchObject({ ok: false });
    expect(progressOf({ ...ended, revision: undefined }, KOALA_INSTALL_PROGRESS)).toMatchObject({ ok: false });
  });

  it('shortens a reason or a line longer than root takes, saying it was shortened, and leaves one that fits as it is', () => {
    expect(boundedWhy('the disk is full')).toBe('the disk is full');
    const long = boundedWhy(`${'x'.repeat(PROGRESS_LIMITS.why)}tail`);
    expect(long).toHaveLength(PROGRESS_LIMITS.why);
    expect(long.endsWith('… (shortened)')).toBe(true);
    expect(progressOf({ stage: 'k3s', title: 'Installing k3s', state: 'failed', why: long }, JOIN_PROGRESS).ok).toBe(true);
    const line = boundedLine('y'.repeat(PROGRESS_LIMITS.line * 2));
    expect(line).toHaveLength(PROGRESS_LIMITS.line);
    expect(progressOf({ stage: 'koala', title: 'Koala', state: 'started', line }, KOALA_INSTALL_PROGRESS).ok).toBe(true);
  });
});
