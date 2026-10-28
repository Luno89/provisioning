import { describe, expect, it } from 'vitest';
import { inviteProblem, leavingProblem, projectDatabase, roleChangeProblem, sameEmail, sharedProjectProblem, sharerOf, type HubMember } from './hub.js';
import { allowed, asPerson, withSharedRole } from '../../platform/lib/permissions.js';

const member = (personId: string, role: HubMember['role'], email = `${personId}@example.com`): HubMember => ({ personId, email, role, joinedAt: 't' });

describe('what each role on a shared project may do', () => {
  const may = (role: HubMember['role'], action: string) => allowed(withSharedRole(asPerson('p'), 'sp', role), action as never, { kind: 'shared-project', id: 'sp' });

  it('lets an owner do everything, a collaborator work, approve and change files, and a client look, pin and ask', () => {
    expect(['invite', 'release', 'see-secrets', 'change-files'].map((action) => may('owner', action))).toEqual([true, true, true, true]);
    expect(['approve-changes', 'work-stories', 'change-files', 'invite', 'release', 'see-secrets'].map((action) => may('collaborator', action))).toEqual([true, true, true, false, false, false]);
    expect(['see-project', 'pin-and-comment', 'ask-koala', 'change-files', 'approve-changes', 'work-stories', 'change-settings'].map((action) => may('client', action))).toEqual([true, true, true, false, false, false, false]);
    expect(allowed(asPerson('p'), 'see-project', { kind: 'shared-project', id: 'sp' })).toBe(false);
  });
});

describe('the people on a shared project', () => {
  const people = [member('ann', 'owner'), member('bo', 'collaborator')];

  it('invites someone new by email with a role, once', () => {
    expect(inviteProblem({ email: 'cy@example.com', role: 'client' }, people, [])).toBeUndefined();
    expect(inviteProblem({ email: 'not an email', role: 'client' }, people, [])).toMatch(/email address/);
    expect(inviteProblem({ email: 'cy@example.com', role: 'admin' }, people, [])).toMatch(/owner, a collaborator, a client/);
    expect(inviteProblem({ email: 'BO@example.com', role: 'client' }, people, [])).toBe('BO@example.com is already on this project');
    expect(inviteProblem({ email: 'cy@example.com', role: 'client' }, people, [{ token: 't', projectId: 'p', email: 'Cy@Example.com', role: 'client', invitedBy: 'ann', createdAt: 't' }])).toMatch(/already invited/);
  });

  it('always keeps one owner', () => {
    expect(roleChangeProblem(people, 'ann', 'client')).toMatch(/always keeps one owner/);
    expect(roleChangeProblem([...people, member('cy', 'owner')], 'ann', 'client')).toBeUndefined();
    expect(roleChangeProblem(people, 'zed', 'client')).toBe('that person is not on this project');
    expect(leavingProblem(people, 'ann')).toMatch(/last owner cannot leave/);
    expect(leavingProblem(people, 'bo')).toBeUndefined();
  });

  it('keeps whoever shared the project from their instance an owner and on it, since it syncs only from there', () => {
    const owners = [...people, member('cy', 'owner')];
    expect(sharerOf({ createdBy: 'ann', origin: { instanceId: 'i', projectId: 'p' } })).toBe('ann');
    expect(sharerOf({ createdBy: 'ann' })).toBeUndefined();
    expect(roleChangeProblem(owners, 'ann', 'collaborator', 'ann')).toMatch(/ann@example.com shared this project from their instance.*stay an owner/);
    expect(roleChangeProblem(owners, 'cy', 'collaborator', 'ann')).toBeUndefined();
    expect(leavingProblem(owners, 'ann', 'ann', 'cy')).toMatch(/cannot be removed; they take it back/);
    expect(leavingProblem(owners, 'ann', 'ann')).toMatch(/take it back there/);
    expect(leavingProblem(owners, 'ann')).toBeUndefined();
    expect(leavingProblem(owners, 'cy', 'ann', 'ann')).toBeUndefined();
  });

  it('matches an invite to an address however it is written', () => {
    expect(sameEmail(' Cy@Example.COM ', 'cy@example.com')).toBe(true);
  });
});

describe('where a shared project keeps its things', () => {
  it('is a database of its own, named only from a well-formed id', () => {
    expect(projectDatabase('0123456789abcdef01234567')).toBe('hub_0123456789abcdef01234567');
    expect(() => projectDatabase('../admin')).toThrow();
    expect(sharedProjectProblem({ name: '  ' })).toBe('a shared project needs a name');
  });
});
