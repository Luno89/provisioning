import { describe, expect, it } from 'vitest';
import {
  KOALA_INSTALL_FOLLOW_PATH, KOALA_INSTALL_FOLLOW_ROUTE, KOALA_INSTALL_LAST_STAGE, KOALA_INSTALL_PROGRESS, KOALA_INSTALL_STAGES,
  KOALA_MOVE_KEYS_PATH, KOALA_MOVE_LAST_STAGE, KOALA_MOVE_PROGRESS, KOALA_MOVE_STAGES,
  koalaInstallEnded, koalaInstallFollowedOf, koalaInstallStoppedOf, koalaInstallLastStage, koalaInstallProgress, koalaInstallStages,
  PROVISION_DONE_STAGE, PROVISION_PIECES, PROVISION_PROGRESS, PROVISIONING_CHANGED,
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
    const named: string[] = [...PROVISION_PIECES.map((piece) => piece.key), ...new Set([...KOALA_INSTALL_STAGES, ...KOALA_MOVE_STAGES])];
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

describe('putting Koala on a machine, and moving it there from Koala\'s servers', () => {
  it('runs the cluster, the chart and Koala, and a move brings the keys before Koala and applies it again once moved', () => {
    expect(koalaInstallStages(false)).toEqual(['cluster', 'chart', 'koala']);
    expect(koalaInstallStages(true)).toEqual(['cluster', 'chart', 'keys', 'koala', 'koala-moved']);
    expect(KOALA_INSTALL_STAGES).toEqual(koalaInstallStages(false));
    expect(KOALA_MOVE_STAGES).toEqual(koalaInstallStages(true));
  });

  it('ends an install on Koala and a move on Koala moved, the only stage that says where Koala answers', () => {
    expect(koalaInstallLastStage(false)).toBe(KOALA_INSTALL_LAST_STAGE);
    expect(koalaInstallLastStage(true)).toBe(KOALA_MOVE_LAST_STAGE);
    expect(koalaInstallProgress(false)).toBe(KOALA_INSTALL_PROGRESS);
    expect(koalaInstallProgress(true)).toBe(KOALA_MOVE_PROGRESS);
    const url = 'https://bo.koala.app';
    expect(progressOf({ stage: 'koala-moved', title: 'Koala moved', state: 'done', url }, KOALA_MOVE_PROGRESS)).toMatchObject({ ok: true });
    expect(progressOf({ stage: 'koala', title: 'Koala', state: 'done' }, KOALA_MOVE_PROGRESS)).toMatchObject({ ok: true });
    expect(progressOf({ stage: 'koala', title: 'Koala', state: 'done', url }, KOALA_MOVE_PROGRESS)).toEqual({ ok: false, problem: 'only the last stage, done, has "url"' });
    expect(progressOf({ stage: 'koala-moved', title: 'Koala moved', state: 'done' }, KOALA_MOVE_PROGRESS)).toMatchObject({ ok: false });
  });

  it('takes a move\'s keys from root\'s move parts, and follows an install on root\'s machines routes', () => {
    expect(KOALA_MOVE_KEYS_PATH).toBe('/api/instances/move/parts/keys');
    expect(KOALA_INSTALL_FOLLOW_PATH).toBe(`/api/machines${KOALA_INSTALL_FOLLOW_ROUTE}`);
  });
});

describe('an install as the join follows it from root', () => {
  const install = { id: 'install-1', machineId: 'desk', state: 'installing', stage: 'koala', title: 'Putting Koala on this machine', line: 'deployment/instance-backend has 0 of 1 available', at: '2026-11-18T10:00:00.000Z' } as const;

  it('takes each change of the install, a move marked so, and the address once ready', () => {
    expect(koalaInstallFollowedOf({ install })).toEqual({ ok: true, value: { install } });
    const moving = { ...install, move: true } as const;
    expect(koalaInstallFollowedOf({ install: moving })).toEqual({ ok: true, value: { install: moving } });
    const ready = { install: { id: 'install-1', machineId: 'desk', state: 'ready', at: install.at }, url: 'https://bo.koala.app' } as const;
    expect(koalaInstallFollowedOf(ready)).toEqual({ ok: true, value: ready });
    const failed = { install: { id: 'install-1', machineId: 'desk', state: 'failed', stage: 'koala', title: 'Putting Koala on this machine', why: 'the chart never came up', at: install.at } } as const;
    expect(koalaInstallFollowedOf(failed)).toEqual({ ok: true, value: failed });
  });

  it('refuses what is not an install, saying what is wrong', () => {
    expect(koalaInstallFollowedOf(null)).toEqual({ ok: false, problem: 'send an object with "install"' });
    expect(koalaInstallFollowedOf({ install, tail: 1 })).toEqual({ ok: false, problem: 'only "install" and "url" are taken, not "tail"' });
    expect(koalaInstallFollowedOf({ install: 'x' })).toEqual({ ok: false, problem: '"install" is an object' });
    expect(koalaInstallFollowedOf({ install: { ...install, state: 'done' } })).toEqual({ ok: false, problem: '"state" is one of asked, installing, ready, failed' });
    expect(koalaInstallFollowedOf({ install: { ...install, id: '' } })).toEqual({ ok: false, problem: '"id" is a non-empty string' });
    expect(koalaInstallFollowedOf({ install: { ...install, line: 3 } })).toEqual({ ok: false, problem: '"line" is a non-empty string' });
    expect(koalaInstallFollowedOf({ install: { ...install, move: false } })).toEqual({ ok: false, problem: '"move" is only ever true' });
    expect(koalaInstallFollowedOf({ install: { ...install, secret: 'x' } })).toEqual({ ok: false, problem: 'an install has only "id", "machineId", "state", "stage", "title", "line", "why", "at" and "move", not "secret"' });
    expect(koalaInstallFollowedOf({ install, url: '' })).toEqual({ ok: false, problem: '"url" is a non-empty string' });
    expect(koalaInstallFollowedOf({ install, url: 'https://bo.koala.app' })).toEqual({ ok: false, problem: 'only a ready install says where Koala answers' });
  });

  it('ends when the install is ready or failed', () => {
    expect(koalaInstallEnded({ state: 'ready' })).toBe(true);
    expect(koalaInstallEnded({ state: 'failed' })).toBe(true);
    expect(koalaInstallEnded({ state: 'asked' })).toBe(false);
    expect(koalaInstallEnded({ state: 'installing' })).toBe(false);
  });

  it('reads why a follow stopped before any install ended, and refuses anything else', () => {
    expect(koalaInstallStoppedOf({ why: 'your Koala runs on Koala\'s servers' })).toEqual({ ok: true, why: 'your Koala runs on Koala\'s servers' });
    for (const raw of [null, 'why', {}, { why: '' }, { why: 'x', more: 1 }]) {
      expect(koalaInstallStoppedOf(raw)).toEqual({ ok: false, problem: 'a stopped follow sends only "why", a non-empty string' });
    }
  });
});
