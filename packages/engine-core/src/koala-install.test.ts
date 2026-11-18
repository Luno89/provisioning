import { describe, expect, it } from 'vitest';
import {
  KOALA_INSTALL_STAGES, PROVISION_DONE_STAGE, PROVISION_PIECES, PROVISION_PROGRESS, PROVISIONING_CHANGED,
  provisionEnding, provisionReportOf,
} from './koala-install.js';
import { progressCases, progressOf } from './machine-progress.js';

const working = { stage: 'gitea', title: 'Gitea, your repositories and images', state: 'started', line: 'statefulset/gitea in gitea: 0 of 1 ready' } as const;

describe('the pieces a Koala sets up after its chart, as its card and root name them', () => {
  it('are the platform services in the order each needs the one before, then monitoring', () => {
    expect(PROVISION_PIECES.map((piece) => piece.key)).toEqual(['egress', 'searxng', 'crawl4ai', 'gitea', 'verdaccio', 'infisical', 'monitoring']);
  });

  it('each have a title a person reads, and a stage name root takes', () => {
    for (const piece of PROVISION_PIECES) {
      expect(piece.title.trim()).not.toBe('');
      expect(progressOf({ stage: piece.key, title: piece.title, state: 'done' }, PROVISION_PROGRESS)).toMatchObject({ ok: true });
    }
  });

  it('end on a stage of their own that no piece and no stage of the machine\'s install uses', () => {
    const named: string[] = [...PROVISION_PIECES.map((piece) => piece.key), ...KOALA_INSTALL_STAGES];
    expect(named).not.toContain(PROVISION_DONE_STAGE);
    expect(new Set(named).size).toBe(named.length);
  });

  it('tell the browser by one event', () => {
    expect(PROVISIONING_CHANGED).toBe('provisioning-changed');
  });
});

describe('a Koala\'s setup, as root hears it on the instance\'s report', () => {
  it('takes each accepted line of the progress contract with the revision it is for', () => {
    for (const accepted of progressCases(PROVISION_PROGRESS).accepted) {
      const progress = { ...accepted, stage: 'gitea' };
      expect(provisionReportOf({ revision: 3, progress })).toEqual({ ok: true, value: { revision: 3, progress } });
    }
    for (const { body, problem } of progressCases(PROVISION_PROGRESS).refused) {
      expect(provisionReportOf({ revision: 3, progress: body })).toEqual({ ok: false, problem });
    }
    expect(provisionReportOf({ revision: 3, progress: working })).toEqual({ ok: true, value: { revision: 3, progress: working } });
    expect(provisionReportOf({ revision: 1, progress: { stage: PROVISION_DONE_STAGE, title: 'Koala is set up', state: 'done' } })).toMatchObject({ ok: true });
  });

  it('refuses what is not a line of the setup, saying what is wrong', () => {
    expect(provisionReportOf(null)).toEqual({ ok: false, problem: 'send an object with "revision" and "progress"' });
    expect(provisionReportOf({ revision: 3, progress: working, tail: 'x' })).toEqual({ ok: false, problem: 'only "revision" and "progress" are taken, not "tail"' });
    for (const revision of [0, -1, 1.5, '3', undefined]) {
      expect(provisionReportOf({ revision, progress: working })).toEqual({ ok: false, problem: '"revision" is the chart revision the setup is for, a whole number from 1' });
    }
    expect(provisionReportOf({ revision: 3, progress: { ...working, url: 'https://bo.koala.app' } })).toEqual({ ok: false, problem: 'only "stage", "title", "state", "why" and "line" are taken, not "url"' });
    expect(provisionReportOf({ revision: 3, progress: { ...working, stage: 'koala' } })).toEqual({ ok: false, problem: '"stage" is one of egress, searxng, crawl4ai, gitea, verdaccio, infisical, monitoring or set-up' });
    for (const state of ['started', 'failed'] as const) {
      expect(provisionReportOf({ revision: 3, progress: { stage: PROVISION_DONE_STAGE, title: 'Koala is set up', state, ...(state === 'failed' ? { why: 'x' } : {}) } }))
        .toEqual({ ok: false, problem: 'the "set-up" stage is only ever done: a piece that fails says so itself' });
    }
  });

  it('ends the setup up only on its own last stage done, failed on any piece that failed, and otherwise not yet', () => {
    expect(provisionEnding({ stage: PROVISION_DONE_STAGE, title: 'Koala is set up', state: 'done' })).toBe('up');
    expect(provisionEnding({ stage: PROVISION_DONE_STAGE, title: 'Koala is set up', state: 'already-done' })).toBe('up');
    expect(provisionEnding({ stage: 'infisical', title: 'Infisical', state: 'failed', why: 'pod infisical-0 is CrashLoopBackOff' })).toBe('failed');
    expect(provisionEnding({ stage: 'monitoring', title: 'Monitoring', state: 'done' })).toBeUndefined();
    expect(provisionEnding(working)).toBeUndefined();
  });
});
