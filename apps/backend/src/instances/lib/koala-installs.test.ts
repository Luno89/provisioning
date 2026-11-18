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
});
