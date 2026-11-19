import { describe, expect, it } from 'vitest';
import { PROVISION_DONE_STAGE, PROVISION_DONE_TITLE } from '@koala/engine-core/koala-install';
import { askedAgain, askedInstall, installFields, installSetupHeard, installUnfinished, installView, stageHeard } from './koala-installs.js';

const asked = askedInstall('install-1', 'desk', '2026-11-18T10:00:00.000Z');
const AT = '2026-11-18T10:01:00.000Z';
const gitea = { stage: 'gitea', title: 'Gitea, your repositories and images' };
const setUp = { stage: PROVISION_DONE_STAGE, title: PROVISION_DONE_TITLE, state: 'done' as const };

describe('what root keeps of Koala being put on a machine', () => {
  it('is made waiting for its workflow to ask the machine, and each ask keeps the stage it last heard', () => {
    expect(asked).toEqual({ id: 'install-1', machineId: 'desk', state: 'asked', at: '2026-11-18T10:00:00.000Z' });
    expect(askedAgain(asked, 'desk', AT)).toEqual({ install: { ...asked, askedAt: AT, at: AT }, status: 'installing', detail: 'Asking desk to put Koala on itself' });
    const heard = { ...asked, state: 'installing' as const, stage: 'cluster', title: 'Starting this machine\'s cluster' };
    expect(askedAgain(heard, 'desk', AT).detail).toBe('desk is putting Koala on itself: Starting this machine\'s cluster');
  });

  it('follows each stage and what it waits on, forgetting the line once the stage moves on', () => {
    const started = stageHeard(asked, { stage: 'koala', title: 'Putting Koala on this machine', state: 'started' }, 'desk', AT);
    expect(started).toEqual({ install: { ...asked, state: 'installing', stage: 'koala', title: 'Putting Koala on this machine', line: undefined, why: undefined, at: AT }, status: 'installing', detail: 'desk is putting Koala on itself: Putting Koala on this machine' });
    const waiting = stageHeard(started.install, { stage: 'koala', title: 'Putting Koala on this machine', state: 'started', line: 'waiting for job/instance-seed-1 runs' }, 'desk', AT);
    expect(waiting.install.line).toBe('waiting for job/instance-seed-1 runs');
    expect(waiting.detail).toBe('desk is putting Koala on itself: Putting Koala on this machine, waiting for job/instance-seed-1 runs');
    expect(stageHeard(waiting.install, { stage: 'chart', title: 'Fetching Koala\'s chart', state: 'done' }, 'desk', AT).install.line).toBeUndefined();
  });

  it('is ready only once the machine has put Koala on itself and Koala has set every piece up, in whichever order the two finish', () => {
    const koalaDone = stageHeard(asked, { stage: 'koala', title: 'Putting Koala on this machine', state: 'already-done', url: 'https://bo.koala.app' }, 'desk', AT);
    expect(koalaDone).toMatchObject({ install: { state: 'installing', koalaUp: true }, status: 'installing', detail: 'Koala on desk is setting itself up', url: 'https://bo.koala.app' });
    expect(installSetupHeard({ install: koalaDone.install, machine: 'desk' }, { revision: 1, progress: setUp }, AT)).toMatchObject({ install: { state: 'ready', setUp: true }, status: 'ready', detail: 'Ready' });
    const setUpFirst = installSetupHeard({ install: asked, machine: 'desk' }, { revision: 1, progress: setUp }, AT)!;
    expect(setUpFirst).toMatchObject({ install: { state: 'installing', setUp: true }, status: 'installing', detail: 'Koala on desk is set up, and desk is finishing putting it on itself' });
    expect(stageHeard(setUpFirst.install, { stage: 'koala', title: 'Putting Koala on this machine', state: 'done', url: 'https://bo.koala.app' }, 'desk', AT))
      .toMatchObject({ install: { state: 'ready' }, status: 'ready', detail: 'Ready', url: 'https://bo.koala.app' });
    expect(stageHeard(asked, { stage: 'cluster', title: 'Starting this machine\'s cluster', state: 'done' }, 'desk', AT).status).toBe('installing');
  });

  it('shows each piece of Koala\'s setup as it comes, keeps what root knows of the setup with it, and fails at the piece that stopped', () => {
    const koalaDone = stageHeard(asked, { stage: 'koala', title: 'Putting Koala on this machine', state: 'done', url: 'https://bo.koala.app' }, 'desk', AT).install;
    const working = installSetupHeard({ install: koalaDone, machine: 'desk' }, { revision: 1, progress: { ...gitea, state: 'started', line: 'waiting for statefulset/gitea in gitea: 0 of 1 ready' } }, AT)!;
    expect(working).toMatchObject({
      install: { state: 'installing', stage: 'gitea', title: gitea.title, line: 'waiting for statefulset/gitea in gitea: 0 of 1 ready' },
      status: 'installing', detail: 'Koala on desk is setting itself up: Gitea, your repositories and images, waiting for statefulset/gitea in gitea: 0 of 1 ready',
      setup: { revision: 1, state: 'running', stage: 'gitea' },
    });
    const failed = installSetupHeard({ install: working.install, setup: working.setup, machine: 'desk' }, { revision: 1, progress: { ...gitea, state: 'failed', why: 'pod gitea-0 is Init:Error' } }, AT)!;
    expect(failed).toMatchObject({ install: { state: 'failed', stage: 'gitea', why: 'pod gitea-0 is Init:Error' }, status: 'failed', detail: 'Koala on desk stopped setting itself up at Gitea, your repositories and images: pod gitea-0 is Init:Error', setup: { state: 'failed' } });
    expect(installSetupHeard({ install: working.install, setup: { ...working.setup!, revision: 2 }, machine: 'desk' }, { revision: 1, progress: setUp }, AT)).toBeUndefined();
  });

  it('fails with the stage it stopped at and why', () => {
    const failed = stageHeard(asked, { stage: 'koala', title: 'Putting Koala on this machine', state: 'failed', why: 'job/instance-seed-2 failed: boom' }, 'desk', AT);
    expect(failed).toMatchObject({ install: { state: 'failed', stage: 'koala', why: 'job/instance-seed-2 failed: boom' }, status: 'failed', detail: 'Putting Koala on desk stopped at Putting Koala on this machine: job/instance-seed-2 failed: boom' });
    expect(installUnfinished(failed.install)).toBe(false);
    expect(installUnfinished(asked)).toBe(true);
  });

  it('is written as the fields it changes, so nothing else on the instance is touched, and records what runs once ready', () => {
    const koalaDone = stageHeard({ ...asked, imageTag: 'v7' }, { stage: 'koala', title: 'Putting Koala', state: 'done', url: 'https://bo.koala.app' }, 'desk', AT);
    expect(installFields(koalaDone, AT)).toEqual({
      'install.state': 'installing', 'install.stage': 'koala', 'install.title': 'Putting Koala', 'install.line': undefined, 'install.why': undefined, 'install.at': AT, 'install.koalaUp': true, 'install.setUp': undefined,
      status: 'installing', detail: 'Koala on desk is setting itself up', updatedAt: AT, url: 'https://bo.koala.app',
    });
    const ready = installSetupHeard({ install: koalaDone.install, machine: 'desk' }, { revision: 1, progress: setUp }, AT)!;
    expect(installFields(ready, AT)).toEqual({
      'install.state': 'ready', 'install.stage': PROVISION_DONE_STAGE, 'install.title': PROVISION_DONE_TITLE, 'install.line': undefined, 'install.why': undefined, 'install.at': AT, 'install.koalaUp': true, 'install.setUp': true,
      status: 'ready', detail: 'Ready', updatedAt: AT, running: 'v7', setup: { revision: 1, state: 'up', stage: PROVISION_DONE_STAGE, title: PROVISION_DONE_TITLE, at: AT },
    });
  });

  it('shows the person the stage, the line and why, and nothing else it keeps', () => {
    expect(installView({ ...asked, state: 'failed', stage: 'koala', title: 'Putting Koala', why: 'no room' })).toEqual({ id: 'install-1', machineId: 'desk', state: 'failed', stage: 'koala', title: 'Putting Koala', why: 'no room', at: asked.at });
  });

  it('marks a move as a move, so the person reads it as Koala moving to the machine', () => {
    expect(installView({ ...asked, move: true })).toEqual({ id: 'install-1', machineId: 'desk', state: 'asked', at: asked.at, move: true });
    expect(installView(asked)).not.toHaveProperty('move');
  });
});

describe('what root keeps of Koala moving from Koala\'s servers onto a machine', () => {
  const moving = askedInstall('install-1', 'desk', '2026-11-18T10:00:00.000Z', true);
  const koalaStage = { stage: 'koala', title: 'Bringing Koala over' };
  const moved = { stage: 'koala-moved', title: 'Starting Koala on this machine' };

  it('is made as a move, and asks the machine to move Koala onto itself', () => {
    expect(moving).toEqual({ id: 'install-1', machineId: 'desk', state: 'asked', at: '2026-11-18T10:00:00.000Z', move: true });
    expect(askedAgain(moving, 'desk', AT).detail).toBe('Asking desk to move Koala onto itself');
    expect(askedAgain({ ...moving, state: 'installing', ...koalaStage }, 'desk', AT).detail).toBe('Moving Koala to desk: Bringing Koala over');
  });

  it('ends its machine\'s part at the move\'s last stage, not at the first Koala it starts', () => {
    const koalaDone = stageHeard(moving, { ...koalaStage, state: 'done' }, 'desk', AT);
    expect(koalaDone).toMatchObject({ install: { state: 'installing' }, detail: 'Moving Koala to desk: Bringing Koala over' });
    expect(koalaDone.install.koalaUp).toBeUndefined();
    const movedDone = stageHeard(koalaDone.install, { ...moved, state: 'done', url: 'http://100.64.0.7:30320' }, 'desk', AT);
    expect(movedDone).toMatchObject({ install: { state: 'installing', koalaUp: true }, detail: 'Koala on desk is setting itself up', url: 'http://100.64.0.7:30320' });
    expect(installSetupHeard({ install: movedDone.install, machine: 'desk' }, { revision: 1, progress: setUp }, AT)).toMatchObject({ install: { state: 'ready' }, detail: 'Switching your address to your machine' });
  });

  it('fails naming the stage it stopped at, as a move', () => {
    expect(stageHeard(moving, { ...koalaStage, state: 'failed', why: 'job/move-mongo-1 failed' }, 'desk', AT))
      .toMatchObject({ install: { state: 'failed', why: 'job/move-mongo-1 failed' }, detail: 'Moving Koala to desk stopped at Bringing Koala over: job/move-mongo-1 failed' });
  });

  it('is written on the move, never on what the instance on Koala\'s servers serves, until the switch', () => {
    const line = stageHeard(moving, { ...koalaStage, state: 'started', line: 'waiting for job/move-data-1 runs' }, 'desk', AT);
    expect(installFields(line, AT)).toEqual({
      'install.state': 'installing', 'install.stage': 'koala', 'install.title': 'Bringing Koala over', 'install.line': 'waiting for job/move-data-1 runs', 'install.why': undefined, 'install.at': AT, 'install.koalaUp': undefined, 'install.setUp': undefined,
      'move.state': 'copying', 'move.detail': 'Moving Koala to desk: Bringing Koala over, waiting for job/move-data-1 runs', updatedAt: AT,
    });
    const movedDone = stageHeard({ ...moving, imageTag: 'v7' }, { ...moved, state: 'done', url: 'http://100.64.0.7:30320' }, 'desk', AT);
    expect(installFields(movedDone, AT)).toMatchObject({ 'move.state': 'copying', 'move.target.url': 'http://100.64.0.7:30320' });
    const ready = installSetupHeard({ install: movedDone.install, machine: 'desk' }, { revision: 1, progress: setUp }, AT)!;
    const written = installFields(ready, AT);
    expect(written).toMatchObject({ 'install.state': 'ready', 'move.state': 'switching', 'move.detail': 'Switching your address to your machine', 'move.setup': { revision: 1, state: 'up' } });
    expect(installFields(askedAgain(moving, 'desk', AT), AT)).toMatchObject({ 'move.state': 'joined', 'move.detail': 'Asking desk to move Koala onto itself' });
    const failed = installFields(stageHeard(moving, { ...koalaStage, state: 'failed', why: 'no room' }, 'desk', AT), AT);
    expect(failed).toMatchObject({ 'move.state': 'failed' });
    for (const fields of [written, failed]) for (const served of ['status', 'detail', 'url', 'running', 'setup']) expect(fields).not.toHaveProperty(served);
  });
});
