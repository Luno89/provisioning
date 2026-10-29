import { describe, expect, it } from 'vitest';
import {
  HANDOVER_TOOL, endedOf, ended, runGrantProblem, handoverPath, handoverPrompt, newRunGrant, outsideScopeProblem, renderHandover, revoked, revokedNotice, revokes,
} from './run-grants.js';
import { asPerson, memberPrincipal } from '../../platform/lib/permissions.js';

const now = new Date('2026-10-29T10:00:00Z');
const owner = newRunGrant({ id: 'g1', ownerId: 'owner', runId: 'run-1', principal: asPerson('owner'), startedBy: 'person', projectId: 'p1', now });
const member = newRunGrant({ id: 'g2', ownerId: 'owner', runId: 'run-2', principal: memberPrincipal('member', 'p1', 'client'), startedBy: 'person', projectId: 'p1', sharedProjectId: 'p1', now });
const platform = newRunGrant({ id: 'g3', ownerId: 'owner', runId: 'run-3', principal: asPerson('owner'), startedBy: 'platform', now });

describe('a run grant', () => {
  it('holds its starter\'s claims as they were, narrowed to what the run is for', () => {
    expect(owner).toMatchObject({ personId: 'owner', runId: 'run-1', state: 'live', scope: { projectId: 'p1' }, issuedAt: now.toISOString() });
    expect(member.personId).toBe('member');
    expect(member.scope).toEqual({ projectId: 'p1', sharedProjectId: 'p1' });
  });

  it('is revoked for what its person started when they sign out everywhere or change their sign-in, never for platform work', () => {
    expect(revokes(owner, { personId: 'owner', because: 'signed-out-everywhere' })).toBe(true);
    expect(revokes(owner, { personId: 'owner', because: 'password-or-2fa' })).toBe(true);
    expect(revokes(platform, { personId: 'owner', because: 'signed-out-everywhere' })).toBe(false);
    expect(revokes(owner, { personId: 'someone-else', because: 'signed-out-everywhere' })).toBe(false);
  });

  it('is revoked whoever started it when the account goes, and on one shared project only when its person is removed from it', () => {
    expect(revokes(platform, { personId: 'owner', because: 'account-removed' })).toBe(true);
    expect(revokes(member, { personId: 'member', because: 'removed-from-shared-project', sharedProjectId: 'p1' })).toBe(true);
    expect(revokes(member, { personId: 'member', because: 'removed-from-shared-project', sharedProjectId: 'p2' })).toBe(false);
    expect(revokes(owner, { personId: 'owner', because: 'removed-from-shared-project', sharedProjectId: 'p1' })).toBe(false);
  });

  it('is revoked or ended once, and an ended grant never comes back', () => {
    const gone = revoked(owner, 'signed-out-everywhere', now);
    expect(gone).toMatchObject({ state: 'revoked', revokedBecause: 'signed-out-everywhere', endedAt: now.toISOString() });
    expect(revokes(gone, { personId: 'owner', because: 'account-removed' })).toBe(false);
    expect(ended(gone, now)).toBe(gone);
    expect(ended(owner, now).state).toBe('ended');
  });
});

describe('what a grant allows at each call', () => {
  it('allows every tool while live but the handover note, which only a revoked run may leave', () => {
    expect(runGrantProblem(owner, 'read_file')).toBeUndefined();
    expect(runGrantProblem(owner, HANDOVER_TOOL)).toMatch(/only for a run whose access was revoked/);
    expect(runGrantProblem(undefined, 'read_file')).toBeUndefined();
    expect(runGrantProblem(undefined, HANDOVER_TOOL)).toMatch(/only for a run whose access was revoked/);
  });

  it('refuses everything but the handover note once revoked, saying why, and everything once ended', () => {
    const gone = revoked(owner, 'signed-out-everywhere', now);
    expect(runGrantProblem(gone, 'run_command')).toBe(`This run's access was revoked because they signed out everywhere, so it may not use run_command. It can only leave a handover note with ${HANDOVER_TOOL}.`);
    expect(runGrantProblem(gone, HANDOVER_TOOL)).toBeUndefined();
    expect(runGrantProblem(ended(owner, now), 'read_file')).toBe('This run has ended, so it may not use read_file.');
  });

  it('keeps a run narrowed to its project off every other one', () => {
    expect(outsideScopeProblem(owner, 'p1', 'read_file')).toBeUndefined();
    expect(outsideScopeProblem(owner, 'p2', 'read_file')).toBe('This run works on its own project, so it may not use read_file on another one.');
    expect(outsideScopeProblem(platform, 'p2', 'read_file')).toBeUndefined();
    expect(outsideScopeProblem(owner, undefined, 'read_file')).toBeUndefined();
  });
});

describe('how a run ended', () => {
  it('says finished, failed with its reason, stopped by whom, or revoked and why', () => {
    const at = now.toISOString();
    expect(endedOf('ok', undefined, {}, at)).toEqual({ how: 'finished', at });
    expect(endedOf('failed', 'the model went away', {}, at)).toEqual({ how: 'failed', reason: 'the model went away', at });
    expect(endedOf('exhausted', 'the budget ran out', {}, at)).toEqual({ how: 'failed', reason: 'the budget ran out', at });
    expect(endedOf('interrupted', 'the run was cancelled', { stoppedBy: 'luno@example.com' }, at)).toEqual({ how: 'stopped', by: 'luno@example.com', reason: 'the run was cancelled', at });
    expect(endedOf('interrupted', 'the run was cancelled', { revokedBecause: 'password-or-2fa' }, at)).toEqual({ how: 'revoked', revokedBecause: 'password-or-2fa', reason: 'the run was cancelled', at });
  });

  it('writes the handover marked as written after access was revoked, and tells the channel', () => {
    expect(handoverPath('run-1')).toBe('handover/run-1.md');
    expect(renderHandover('Did the first half.', 'signed-out-everywhere', '2026-10-29T10:00:00Z')).toMatch(/^# Handover\n\nWritten after access was revoked: they signed out everywhere \(2026-10-29T10:00:00Z\)\.[\s\S]*Did the first half\.\n$/);
    expect(revokedNotice('luno@example.com', 'signed-out-everywhere', { note: 'x' })).toBe('This run was ended because luno@example.com\'s access was revoked (they signed out everywhere). It left a handover note.');
    expect(revokedNotice('luno@example.com', 'account-removed', { failed: 'the model did not answer' })).toBe('This run was ended because luno@example.com\'s access was revoked (their account is being removed). It could not leave a handover note: the model did not answer.');
  });

  it('asks the model for the note from what the run was asked and did', () => {
    const prompt = handoverPrompt('signed-out-everywhere', 'Fix the login page', [{ name: 'read_file', ok: true, digest: 'login.tsx' }, { name: 'run_command', ok: false }]);
    expect(prompt.system).toContain(HANDOVER_TOOL);
    expect(prompt.user).toBe('What the run was asked:\nFix the login page\n\nWhat it did, in order:\n- read_file: login.tsx\n- run_command (failed)');
  });
});
