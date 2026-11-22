import { describe, expect, it } from 'vitest';
import { PROVISION_DONE_STAGE, PROVISION_DONE_TITLE } from '@koala/engine-core/koala-install';
import { askedAbout, setupAgainAsked, setupAgainOf, setupHeard, setupSaid, statusSettled, type InstanceSetup } from './instance-setup.js';

const AT = '2026-11-18T10:01:00.000Z';
const gitea = { stage: 'gitea', title: 'Gitea, your repositories and images' };
const working: InstanceSetup = { revision: 4, run: 'run-1', state: 'running', ...gitea, line: 'waiting for statefulset/gitea in gitea: 0 of 1 ready', at: AT };

describe('what root keeps of a Koala setting itself up after its chart', () => {
  it('follows the piece under way and what it waits on, failed with why at the piece that stopped, and up only once the setup says so', () => {
    expect(setupHeard(undefined, { revision: 4, run: 'run-1', progress: { ...gitea, state: 'started', line: 'waiting for statefulset/gitea in gitea: 0 of 1 ready' } }, AT)).toEqual(working);
    expect(setupHeard(working, { revision: 4, run: 'run-1', progress: { ...gitea, state: 'done' } }, AT)).toEqual({ revision: 4, run: 'run-1', state: 'running', ...gitea, at: AT });
    expect(setupHeard(working, { revision: 4, run: 'run-1', progress: { ...gitea, state: 'failed', why: 'pod gitea-0 is Init:Error' } }, AT)).toEqual({ revision: 4, run: 'run-1', state: 'failed', ...gitea, why: 'pod gitea-0 is Init:Error', at: AT });
    expect(setupHeard(working, { revision: 4, run: 'run-1', progress: { stage: PROVISION_DONE_STAGE, title: PROVISION_DONE_TITLE, state: 'done' } }, AT)).toEqual({ revision: 4, run: 'run-1', state: 'up', stage: PROVISION_DONE_STAGE, title: PROVISION_DONE_TITLE, at: AT });
  });

  it('takes a later revision\'s setup over an earlier one, and nothing from a setup of a revision it has already moved past', () => {
    expect(setupHeard(working, { revision: 5, run: 'run-1', progress: { ...gitea, state: 'started' } }, AT)).toMatchObject({ revision: 5, state: 'running' });
    expect(setupHeard(working, { revision: 3, run: 'run-1', progress: { stage: PROVISION_DONE_STAGE, title: PROVISION_DONE_TITLE, state: 'done' } }, AT)).toBeUndefined();
  });

  it('says what the person sees on My Machines, naming the machine when Koala is on one', () => {
    expect(setupSaid(working, 'desk')).toEqual({ status: 'installing', detail: 'Koala on desk is setting itself up: Gitea, your repositories and images, waiting for statefulset/gitea in gitea: 0 of 1 ready' });
    expect(setupSaid({ ...working, line: undefined }, undefined)).toEqual({ status: 'installing', detail: 'Koala is setting itself up: Gitea, your repositories and images' });
    expect(setupSaid({ ...working, state: 'failed', line: undefined, why: 'pod gitea-0 is Init:Error' }, 'desk')).toEqual({ status: 'failed', detail: 'Koala on desk stopped setting itself up at Gitea, your repositories and images: pod gitea-0 is Init:Error' });
    expect(setupSaid({ ...working, state: 'up' }, 'desk')).toEqual({ status: 'ready', detail: 'Ready' });
    expect(setupSaid({ ...working, state: 'failed', why: 'x'.repeat(600) }, 'desk').detail).toHaveLength(500);
  });

  it('lets a report naming the revision it runs be ready only once that revision is set up, and never hides a piece that failed', () => {
    const running = { status: 'installing' as const, detail: 'Running v7' };
    expect(statusSettled(running, 4, { ...working, state: 'up' }, 'desk')).toEqual({ status: 'ready', detail: 'Running v7' });
    expect(statusSettled(running, 4, { ...working, state: 'failed', line: undefined, why: 'pod gitea-0 is Init:Error' }, 'desk')).toEqual({ status: 'failed', detail: 'Koala on desk stopped setting itself up at Gitea, your repositories and images: pod gitea-0 is Init:Error' });
    expect(statusSettled(running, 4, working, 'desk')).toEqual({ status: 'installing', detail: 'Koala on desk is setting itself up: Gitea, your repositories and images, waiting for statefulset/gitea in gitea: 0 of 1 ready' });
    expect(statusSettled({ status: 'installing', detail: 'Upgraded to v8' }, 5, { ...working, state: 'up' }, 'desk')).toEqual({ status: 'installing', detail: 'Upgraded to v8' });
    expect(statusSettled({ status: 'installing', detail: 'Upgraded to v8' }, 5, undefined, 'desk')).toEqual({ status: 'installing', detail: 'Upgraded to v8' });
  });

  it('holds a ready that names no revision to the latest setup heard, and takes everything else as it says', () => {
    expect(statusSettled({ status: 'ready', detail: 'Installed' }, undefined, { ...working, state: 'failed', line: undefined, why: 'no' }, 'desk')).toEqual({ status: 'failed', detail: 'Koala on desk stopped setting itself up at Gitea, your repositories and images: no' });
    expect(statusSettled({ status: 'ready', detail: 'Installed' }, undefined, { ...working, state: 'up' }, 'desk')).toEqual({ status: 'ready', detail: 'Installed' });
    expect(statusSettled({ status: 'ready', detail: 'Installed' }, undefined, undefined, 'desk')).toEqual({ status: 'ready', detail: 'Installed' });
    expect(statusSettled({ status: 'failed', detail: 'The upgrade to v8 failed, so it was rolled back to v7' }, undefined, { ...working, state: 'up' }, 'desk')).toEqual({ status: 'failed', detail: 'The upgrade to v8 failed, so it was rolled back to v7' });
  });
});

describe('setting a Koala up again after its setup stopped', () => {
  const stopped: InstanceSetup = { ...working, state: 'failed', line: undefined, why: 'pod gitea-0 is Init:Error' };
  const koala = { status: 'failed' as const, machine: 'desk', install: { revision: 4 }, setup: stopped };

  it('offers it only where the setup of the revision the Koala was put on stopped', () => {
    expect(setupAgainOf(koala)).toBe('stopped');
    expect(setupAgainOf({ ...koala, setupAsked: { revision: 4, run: 'run-1', at: AT } })).toBe('asked');
    expect(setupAgainOf({ ...koala, setup: working, status: 'installing' })).toBeUndefined();
    expect(setupAgainOf({ ...koala, setup: undefined })).toBeUndefined();
    expect(setupAgainOf({ ...koala, install: { revision: 5 } })).toBeUndefined();
  });

  it('asks from the step that stopped, saying whether the Koala hears it now or once it connects', () => {
    expect(setupAgainAsked(koala, true, AT)).toEqual({ ok: true, patch: { setupAsked: { revision: 4, run: 'run-1', at: AT }, status: 'installing', detail: 'Asking Koala on desk to set itself up again from Gitea, your repositories and images' } });
    expect(setupAgainAsked(koala, false, AT)).toMatchObject({ ok: true, patch: { detail: 'Koala on desk sets itself up again from Gitea, your repositories and images once it connects to root' } });
    expect(setupAgainAsked({ ...koala, setup: working, status: 'installing' }, true, AT)).toEqual({ ok: false, error: 'Koala on desk has not stopped setting itself up, so there is nothing to set up again' });
  });

  it('knows a report of the attempt an ask is about from the next attempt\'s, so hearing the old failure again keeps the ask', () => {
    const asked = { ...koala, setupAsked: { revision: 4, run: 'run-1', at: AT } };
    const failedAgain = { revision: 4, run: 'run-1', progress: { ...gitea, state: 'failed' as const, why: 'the volume is full' } };
    expect(askedAbout(asked, failedAgain)).toBe(true);
    expect(askedAbout(asked, { ...failedAgain, run: 'run-2' })).toBe(false);
    expect(askedAbout(koala, failedAgain)).toBe(false);
  });
});
