import { describe, expect, it } from 'vitest';
import { askedAgain, askedInstall, installFields, installUnfinished, installView, stageHeard } from './koala-installs.js';

const asked = askedInstall('install-1', 'desk', '2026-11-18T10:00:00.000Z');
const AT = '2026-11-18T10:01:00.000Z';

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

  it('is ready only when the last stage is done, with where Koala answers', () => {
    expect(stageHeard(asked, { stage: 'koala', title: 'Putting Koala on this machine', state: 'already-done', url: 'https://bo.koala.app' }, 'desk', AT))
      .toMatchObject({ install: { state: 'ready' }, status: 'ready', detail: 'Ready', url: 'https://bo.koala.app' });
    expect(stageHeard(asked, { stage: 'cluster', title: 'Starting this machine\'s cluster', state: 'done' }, 'desk', AT).status).toBe('installing');
  });

  it('fails with the stage it stopped at and why', () => {
    const failed = stageHeard(asked, { stage: 'koala', title: 'Putting Koala on this machine', state: 'failed', why: 'job/instance-seed-2 failed: boom' }, 'desk', AT);
    expect(failed).toMatchObject({ install: { state: 'failed', stage: 'koala', why: 'job/instance-seed-2 failed: boom' }, status: 'failed', detail: 'Putting Koala on desk stopped at Putting Koala on this machine: job/instance-seed-2 failed: boom' });
    expect(installUnfinished(failed.install)).toBe(false);
    expect(installUnfinished(asked)).toBe(true);
  });

  it('is written as the fields it changes, so nothing else on the instance is touched, and records what runs once ready', () => {
    const ready = stageHeard({ ...asked, imageTag: 'v7' }, { stage: 'koala', title: 'Putting Koala', state: 'done', url: 'https://bo.koala.app' }, 'desk', AT);
    expect(installFields(ready, AT)).toEqual({
      'install.state': 'ready', 'install.stage': 'koala', 'install.title': 'Putting Koala', 'install.line': undefined, 'install.why': undefined, 'install.at': AT,
      status: 'ready', detail: 'Ready', updatedAt: AT, url: 'https://bo.koala.app', running: 'v7',
    });
  });

  it('shows the person the stage, the line and why, and nothing else it keeps', () => {
    expect(installView({ ...asked, state: 'failed', stage: 'koala', title: 'Putting Koala', why: 'no room' })).toEqual({ id: 'install-1', machineId: 'desk', state: 'failed', stage: 'koala', title: 'Putting Koala', why: 'no room', at: asked.at });
  });
});
