import { describe, expect, it } from 'vitest';
import { PROVISION_DONE_STAGE, PROVISION_DONE_TITLE } from '@koala/engine-core/koala-install';
import { askedAgain, askedInstall, installFields, installSetupHeard, installUnfinished, installView, stageHeard } from './koala-installs.js';

const asked = askedInstall('install-1', 'desk', '2026-11-18T10:00:00.000Z');
const AT = '2026-11-18T10:01:00.000Z';
const gitea = { stage: 'gitea', title: 'Gitea, your repositories and images' };
const setUp = { stage: PROVISION_DONE_STAGE, title: PROVISION_DONE_TITLE, state: 'done' as const };
const egress = { stage: 'egress', title: 'The egress proxy' };
const koalaOn = (revision: number, state: 'done' | 'already-done' = 'done') => ({ stage: 'koala', title: 'Putting Koala on this machine', state, url: 'https://bo.koala.app', revision });

describe('what root keeps of Koala being put on a machine', () => {
  it('is made waiting for its workflow to ask the machine, and each ask keeps the stage it last heard', () => {
    expect(asked).toEqual({ id: 'install-1', machineId: 'desk', state: 'asked', at: '2026-11-18T10:00:00.000Z' });
    expect(askedAgain(asked, 'desk', AT)).toEqual({ install: { ...asked, askedAt: AT, at: AT }, status: 'installing', detail: 'Asking desk to put Koala on itself' });
    const heard = { ...asked, state: 'installing' as const, stage: 'cluster', title: 'Starting this machine\'s cluster' };
    expect(askedAgain(heard, 'desk', AT).detail).toBe('desk is putting Koala on itself: Starting this machine\'s cluster');
  });

  it('follows each stage and what it waits on, forgetting the line once the stage moves on', () => {
    const started = stageHeard({ install: asked }, { stage: 'koala', title: 'Putting Koala on this machine', state: 'started' }, 'desk', AT);
    expect(started).toEqual({ install: { ...asked, state: 'installing', stage: 'koala', title: 'Putting Koala on this machine', line: undefined, why: undefined, at: AT }, status: 'installing', detail: 'desk is putting Koala on itself: Putting Koala on this machine' });
    const waiting = stageHeard({ install: started.install }, { stage: 'koala', title: 'Putting Koala on this machine', state: 'started', line: 'waiting for job/instance-seed-1 runs' }, 'desk', AT);
    expect(waiting.install.line).toBe('waiting for job/instance-seed-1 runs');
    expect(waiting.detail).toBe('desk is putting Koala on itself: Putting Koala on this machine, waiting for job/instance-seed-1 runs');
    expect(stageHeard({ install: waiting.install }, { stage: 'chart', title: 'Fetching Koala\'s chart', state: 'done' }, 'desk', AT).install.line).toBeUndefined();
  });

  it('is ready only once the machine has put Koala on itself and Koala has set every piece up, in whichever order the two finish', () => {
    const koalaDone = stageHeard({ install: asked }, koalaOn(1, 'already-done'), 'desk', AT);
    expect(koalaDone).toMatchObject({ install: { state: 'installing', revision: 1 }, status: 'installing', detail: 'Koala on desk is setting itself up', url: 'https://bo.koala.app' });
    expect(installSetupHeard({ install: koalaDone.install, machine: 'desk' }, { revision: 1, run: 'run-1', progress: setUp }, AT)).toMatchObject({ install: { state: 'ready' }, status: 'ready', detail: 'Ready' });
    const setUpFirst = installSetupHeard({ install: asked, machine: 'desk' }, { revision: 1, run: 'run-1', progress: setUp }, AT)!;
    expect(setUpFirst).toMatchObject({ install: { state: 'asked' }, status: 'installing', detail: 'Asking desk to put Koala on itself', setup: { revision: 1, state: 'up' } });
    expect(stageHeard({ install: setUpFirst.install, setup: setUpFirst.setup }, koalaOn(1), 'desk', AT))
      .toMatchObject({ install: { state: 'ready' }, status: 'ready', detail: 'Ready', url: 'https://bo.koala.app' });
    expect(stageHeard({ install: asked }, { stage: 'cluster', title: 'Starting this machine\'s cluster', state: 'done' }, 'desk', AT).status).toBe('installing');
  });

  it('shows each piece of Koala\'s setup as it comes, keeps what root knows of the setup with it, and fails at the piece that stopped', () => {
    const koalaDone = stageHeard({ install: asked }, koalaOn(1), 'desk', AT).install;
    const working = installSetupHeard({ install: koalaDone, machine: 'desk' }, { revision: 1, run: 'run-1', progress: { ...gitea, state: 'started', line: 'waiting for statefulset/gitea in gitea: 0 of 1 ready' } }, AT)!;
    expect(working).toMatchObject({
      install: { state: 'installing', stage: 'gitea', title: gitea.title, line: 'waiting for statefulset/gitea in gitea: 0 of 1 ready' },
      status: 'installing', detail: 'Koala on desk is setting itself up: Gitea, your repositories and images, waiting for statefulset/gitea in gitea: 0 of 1 ready',
      setup: { revision: 1, state: 'running', stage: 'gitea' },
    });
    const failed = installSetupHeard({ install: working.install, setup: working.setup, machine: 'desk' }, { revision: 1, run: 'run-1', progress: { ...gitea, state: 'failed', why: 'pod gitea-0 is Init:Error' } }, AT)!;
    expect(failed).toMatchObject({ install: { state: 'failed', stage: 'gitea', why: 'pod gitea-0 is Init:Error' }, status: 'failed', detail: 'Koala on desk stopped setting itself up at Gitea, your repositories and images: pod gitea-0 is Init:Error', setup: { state: 'failed' } });
    expect(installSetupHeard({ install: working.install, setup: { ...working.setup!, revision: 2 }, machine: 'desk' }, { revision: 1, run: 'run-1', progress: setUp }, AT)).toBeUndefined();
  });

  it('after an install whose setup failed, a new one shows its own progress and never the earlier revision\'s failure, and still fails at once when its own setup does', () => {
    const egressFailed = { revision: 1, run: 'run-1', progress: { ...egress, state: 'failed' as const, why: 'the setup could not start: The engine is not connected to Temporal' } };
    const stale = installSetupHeard({ install: asked, machine: 'desk' }, egressFailed, AT)!;
    expect(stale).toMatchObject({ install: { state: 'asked' }, status: 'installing', detail: 'Asking desk to put Koala on itself' });
    const rolled = stageHeard({ install: stale.install, setup: stale.setup }, koalaOn(2), 'desk', AT);
    expect(rolled).toMatchObject({ install: { state: 'installing', revision: 2 }, status: 'installing', detail: 'Koala on desk is setting itself up' });
    const own = installSetupHeard({ install: rolled.install, setup: stale.setup, machine: 'desk' }, { revision: 2, run: 'run-1', progress: { ...egress, state: 'started', line: 'applying the egress stack' } }, AT)!;
    expect(own).toMatchObject({ install: { state: 'installing', stage: 'egress' }, status: 'installing', detail: 'Koala on desk is setting itself up: The egress proxy, applying the egress stack', setup: { revision: 2, state: 'running' } });
    const ownFailed = installSetupHeard({ install: own.install, setup: own.setup, machine: 'desk' }, { revision: 2, run: 'run-1', progress: { ...egress, state: 'failed', why: 'pod egress-0 is CrashLoopBackOff' } }, AT)!;
    expect(ownFailed).toMatchObject({ install: { state: 'failed', why: 'pod egress-0 is CrashLoopBackOff' }, status: 'failed', detail: 'Koala on desk stopped setting itself up at The egress proxy: pod egress-0 is CrashLoopBackOff' });
    expect(stageHeard({ install: stale.install, setup: stale.setup }, koalaOn(1, 'already-done'), 'desk', AT))
      .toMatchObject({ install: { state: 'failed' }, status: 'failed', detail: 'Koala on desk stopped setting itself up at The egress proxy: the setup could not start: The engine is not connected to Temporal' });
  });

  it('fails with the stage it stopped at and why', () => {
    const failed = stageHeard({ install: asked }, { stage: 'koala', title: 'Putting Koala on this machine', state: 'failed', why: 'job/instance-seed-2 failed: boom' }, 'desk', AT);
    expect(failed).toMatchObject({ install: { state: 'failed', stage: 'koala', why: 'job/instance-seed-2 failed: boom' }, status: 'failed', detail: 'Putting Koala on desk stopped at Putting Koala on this machine: job/instance-seed-2 failed: boom' });
    expect(installUnfinished(failed.install)).toBe(false);
    expect(installUnfinished(asked)).toBe(true);
  });

  it('is written as the fields it changes, so nothing else on the instance is touched, and records what runs once ready', () => {
    const koalaDone = stageHeard({ install: { ...asked, imageTag: 'v7' } }, { stage: 'koala', title: 'Putting Koala', state: 'done', url: 'https://bo.koala.app', revision: 1 }, 'desk', AT);
    expect(installFields(koalaDone, AT)).toEqual({
      'install.state': 'installing', 'install.stage': 'koala', 'install.title': 'Putting Koala', 'install.line': undefined, 'install.why': undefined, 'install.at': AT, 'install.revision': 1,
      status: 'installing', detail: 'Koala on desk is setting itself up', updatedAt: AT, url: 'https://bo.koala.app',
    });
    const ready = installSetupHeard({ install: koalaDone.install, machine: 'desk' }, { revision: 1, run: 'run-1', progress: setUp }, AT)!;
    expect(installFields(ready, AT)).toEqual({
      'install.state': 'ready', 'install.stage': PROVISION_DONE_STAGE, 'install.title': PROVISION_DONE_TITLE, 'install.line': undefined, 'install.why': undefined, 'install.at': AT, 'install.revision': 1,
      status: 'ready', detail: 'Ready', updatedAt: AT, running: 'v7', setup: { revision: 1, run: 'run-1', state: 'up', stage: PROVISION_DONE_STAGE, title: PROVISION_DONE_TITLE, at: AT },
    });
  });

  it('shows the person the stage, the line and why, and nothing else it keeps', () => {
    expect(installView({ ...asked, state: 'failed', stage: 'koala', title: 'Putting Koala', why: 'no room' })).toEqual({ id: 'install-1', machineId: 'desk', state: 'failed', stage: 'koala', title: 'Putting Koala', why: 'no room', at: asked.at });
  });
});
