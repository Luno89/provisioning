import { describe, expect, it, vi } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import { asPerson, memberPrincipal } from '../../platform/lib/permissions.js';
import { RunGrantService } from './RunGrantService.js';
import { HANDOVER_TOOL } from '../lib/run-grants.js';

const now = new Date('2026-10-29T10:00:00Z');

async function service() {
  const db = await testDatabase();
  const signalRevoked = vi.fn(async () => undefined);
  let next = 0;
  const grants = new RunGrantService({ store: db.engine, signalRevoked, now: () => now, newId: () => `grant-${++next}` });
  return { db, grants, signalRevoked };
}

describe('the run grants a person\'s runs work with', () => {
  it('issues a grant the run works with until the run ends, then refuses any further call', async () => {
    const { grants } = await service();
    const grant = await grants.issue({ ownerId: 'owner', runId: 'run-1', principal: asPerson('owner'), startedBy: 'person', projectId: 'p1' });
    expect(await grants.callProblem(grant.id, 'read_file', 'p1')).toBeUndefined();
    expect(await grants.callProblem(grant.id, 'read_file', 'p2')).toBe('This run works on its own project, so it may not use read_file on another one.');

    const { ending } = await grants.runEnded({ ownerId: 'owner', runId: 'run-1', agentSlug: 'koala', depth: 0, outcome: 'ok' });
    expect(ending.ended).toEqual({ how: 'finished', at: now.toISOString() });
    expect(await grants.callProblem(grant.id, 'read_file', 'p1')).toBe('This run has ended, so it may not use read_file.');
    expect(await grants.callProblem('grant-unknown', 'read_file', undefined)).toMatch(/is not known here/);
  });

  it('revokes what a person started when they sign out everywhere, tells each run, and leaves platform work running', async () => {
    const { grants, signalRevoked } = await service();
    const theirs = await grants.issue({ ownerId: 'owner', runId: 'run-chat', principal: asPerson('owner'), startedBy: 'person' });
    const platform = await grants.issue({ ownerId: 'owner', runId: 'run-release', principal: asPerson('owner'), startedBy: 'platform' });

    const revoked = await grants.revokeGrantsOf({ personId: 'owner', because: 'signed-out-everywhere' });
    expect(revoked.map((grant) => grant.runId)).toEqual(['run-chat']);
    expect(signalRevoked).toHaveBeenCalledWith('run-chat', { because: 'signed-out-everywhere', at: now.toISOString() });
    expect(await grants.callProblem(theirs.id, 'run_command', undefined)).toMatch(/access was revoked because they signed out everywhere/);
    expect(await grants.callProblem(theirs.id, HANDOVER_TOOL, undefined)).toBeUndefined();
    expect(await grants.callProblem(platform.id, 'run_command', undefined)).toBeUndefined();

    const { ending } = await grants.runEnded({ ownerId: 'owner', runId: 'run-chat', agentSlug: 'koala', depth: 0, outcome: 'interrupted', reason: 'the run was cancelled', revokedBecause: 'signed-out-everywhere', handover: { note: 'Half done.' } });
    expect(ending).toMatchObject({ ended: { how: 'revoked', revokedBecause: 'signed-out-everywhere' }, handover: { note: 'Half done.' } });
  });

  it('ends a member\'s runs on the shared project they were removed from, and every run of an account being removed', async () => {
    const { grants } = await service();
    await grants.issue({ ownerId: 'owner', runId: 'run-ask', principal: memberPrincipal('member', 'p1', 'client'), startedBy: 'person', projectId: 'p1', sharedProjectId: 'hub-1' });
    expect(await grants.revokeGrantsOf({ personId: 'member', because: 'removed-from-shared-project', sharedProjectId: 'hub-2' })).toEqual([]);
    expect((await grants.revokeGrantsOf({ personId: 'member', because: 'removed-from-shared-project', sharedProjectId: 'hub-1' })).map((grant) => grant.runId)).toEqual(['run-ask']);

    await grants.issue({ ownerId: 'owner', runId: 'run-release', principal: asPerson('owner'), startedBy: 'platform' });
    expect((await grants.revokeGrantsOf({ personId: 'owner', because: 'account-removed' })).map((grant) => grant.runId)).toEqual(['run-release']);
  });

  it('records how every run ended, child runs too, and who stopped one', async () => {
    const { grants } = await service();
    await grants.runEnded({ ownerId: 'owner', runId: 'run-1-research-1', agentSlug: 'research', depth: 1, outcome: 'failed', reason: 'the model went away' });
    await grants.runEnded({ ownerId: 'owner', runId: 'run-2', agentSlug: 'koala', depth: 0, outcome: 'interrupted', reason: 'the run was cancelled', stoppedBy: 'owner@example.com' });
    const endings = await grants.endings('owner', ['run-1-research-1', 'run-2', 'run-unknown']);
    expect(endings.map((ending) => [ending.runId, ending.ended?.how, ending.ended?.by ?? ending.ended?.reason])).toEqual(expect.arrayContaining([
      ['run-1-research-1', 'failed', 'the model went away'],
      ['run-2', 'stopped', 'owner@example.com'],
    ]));
    expect(await grants.endings('someone-else', ['run-2'])).toEqual([]);
  });

  it('keeps a handover a revoked run left, beside how it ended', async () => {
    const { grants } = await service();
    await grants.keepHandover('owner', 'run-3', { note: 'Read the logs; the fix is in auth.ts.', path: 'handover/run-3.md' });
    await grants.runEnded({ ownerId: 'owner', runId: 'run-3', agentSlug: 'koala', depth: 0, outcome: 'interrupted', revokedBecause: 'password-or-2fa' });
    const [ending] = await grants.endings('owner', ['run-3']);
    expect(ending).toMatchObject({ handover: { note: 'Read the logs; the fix is in auth.ts.', path: 'handover/run-3.md' }, ended: { how: 'revoked', revokedBecause: 'password-or-2fa' } });
  });
});
