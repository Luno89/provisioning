import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS, SHARED_ROLES, allowed, authorize, claimsOf, clusterResource, principalOf, sharedActionsOf, withSharedRole,
  type Principal, type Resource, type SharedAction, type SharedRole,
} from './permissions.js';

const person = (id: string, extra: Principal['claims'] = []): Principal => ({ kind: 'person', id, claims: [{ role: 'person' }, ...extra] });
const operator = person('op', [{ role: 'operator' }]);
const instanceOwner = person('owner', [{ role: 'operator' }, { role: 'instance-owner' }]);
const someone = person('someone');

describe('claimsOf', () => {
  it('gives the operator claim from isAdmin on root and combined, never on the hub', () => {
    expect(claimsOf({ id: 'a', isAdmin: true }, { role: 'root' })).toEqual([{ role: 'person' }, { role: 'operator' }]);
    expect(claimsOf({ id: 'a', isAdmin: true }, { role: 'combined' })).toEqual([{ role: 'person' }, { role: 'operator' }]);
    expect(claimsOf({ id: 'a', isAdmin: true }, { role: 'hub' })).toEqual([{ role: 'person' }]);
    expect(claimsOf({ id: 'a' }, { role: 'combined' })).toEqual([{ role: 'person' }]);
  });

  it('makes the instance owner the operator of their instance by its owner id, whatever isAdmin says', () => {
    expect(claimsOf({ id: 'owner', isAdmin: false }, { role: 'instance', instanceOwnerId: 'owner' }))
      .toEqual([{ role: 'person' }, { role: 'operator' }, { role: 'instance-owner' }]);
    expect(claimsOf({ id: 'other', isAdmin: true }, { role: 'instance', instanceOwnerId: 'owner' })).toEqual([{ role: 'person' }]);
    expect(claimsOf({ id: 'owner', isAdmin: true }, { role: 'instance' })).toEqual([{ role: 'person' }]);
  });

  it('builds a principal with them', () => {
    expect(principalOf({ id: 'a', isAdmin: true }, { role: 'root' })).toEqual({ kind: 'person', id: 'a', claims: [{ role: 'person' }, { role: 'operator' }] });
  });
});

describe('the permissions table', () => {
  it('lets only the operator act on the install, with a 403', () => {
    for (const action of Object.keys(PERMISSIONS.install) as (keyof typeof PERMISSIONS.install)[]) {
      expect(allowed(operator, action, { kind: 'install' }), action).toBe(true);
      expect(allowed(instanceOwner, action, { kind: 'install' }), action).toBe(true);
      expect(authorize(someone, action, { kind: 'install' }), action).toMatchObject({ allowed: false, status: 403 });
    }
  });

  it('lets only the instance owner change the instance settings', () => {
    expect(allowed(instanceOwner, 'change', { kind: 'instance-settings' })).toBe(true);
    expect(authorize(operator, 'change', { kind: 'instance-settings' })).toMatchObject({ allowed: false, status: 403 });
    expect(allowed(someone, 'change', { kind: 'instance-settings' })).toBe(false);
  });

  it('lets a person remove their own account, and only the operator anyone else\'s', () => {
    expect(allowed(someone, 'remove', { kind: 'account', id: 'someone' })).toBe(true);
    expect(authorize(someone, 'remove', { kind: 'account', id: 'other' })).toEqual({ allowed: false, status: 403, error: 'Only an admin can remove someone else\'s account' });
    expect(allowed(operator, 'remove', { kind: 'account', id: 'other' })).toBe(true);
  });

  it('lets anyone see and deploy to the system cluster, only the operator see all of it or change it, and nobody delete it', () => {
    const system = clusterResource({ id: 'sys', isSystem: true });
    expect(allowed(someone, 'see', system)).toBe(true);
    expect(allowed(someone, 'deploy-to', system)).toBe(true);
    expect(authorize(someone, 'see-everything', system)).toMatchObject({ allowed: false, status: 404 });
    expect(authorize(someone, 'change', system)).toMatchObject({ allowed: false, status: 403 });
    expect(allowed(operator, 'see-everything', system)).toBe(true);
    expect(allowed(operator, 'change', system)).toBe(true);
    expect(authorize(operator, 'delete', system)).toMatchObject({ allowed: false, status: 403 });
  });

  it('keeps every other record to its owner, hiding it from anyone else, operator included', () => {
    const owned: Resource[] = [
      clusterResource({ id: 'c', ownerId: 'someone' }),
      { kind: 'deployment', ownerId: 'someone' },
      { kind: 'project', ownerId: 'someone' },
      { kind: 'record', noun: 'conversation', ownerId: 'someone' },
    ];
    for (const resource of owned) {
      for (const action of Object.keys(PERMISSIONS[resource.kind]) as never[]) {
        expect(allowed(someone, action, resource), `${resource.kind} ${action}`).toBe(true);
        expect(authorize(person('other'), action, resource), `${resource.kind} ${action}`).toMatchObject({ allowed: false, status: resource.kind === 'project' && action !== 'see' ? 403 : 404 });
        expect(allowed(operator, action, resource), `${resource.kind} ${action}`).toBe(false);
      }
    }
  });

  it('gives a record with no owner to nobody', () => {
    expect(allowed(operator, 'see', { kind: 'project' })).toBe(false);
    expect(allowed(someone, 'see', { kind: 'project', ownerId: '' })).toBe(false);
  });

  it('lets a workflow\'s owner and the operator see and cancel it', () => {
    for (const action of ['see', 'cancel'] as const) {
      expect(allowed(someone, action, { kind: 'workflow', owner: 'someone' })).toBe(true);
      expect(allowed(operator, action, { kind: 'workflow', owner: 'someone' })).toBe(true);
      expect(authorize(person('other'), action, { kind: 'workflow', owner: 'someone' })).toMatchObject({ allowed: false, status: 404 });
      expect(allowed(someone, action, { kind: 'workflow' })).toBe(false);
    }
  });

  const SHARED_EXPECTED: Record<SharedRole, readonly SharedAction[]> = {
    owner: ['see-project', 'see-people', 'invite', 'change-roles', 'remove-people', 'change-files', 'approve-changes', 'work-stories', 'release', 'see-secrets', 'change-settings', 'pin-and-comment', 'ask-koala'],
    collaborator: ['see-project', 'see-people', 'change-files', 'approve-changes', 'work-stories', 'pin-and-comment'],
    client: ['see-project', 'see-people', 'pin-and-comment', 'ask-koala'],
  };

  it('gives each role on a shared project exactly its actions, there and nowhere else', () => {
    for (const role of SHARED_ROLES) {
      const member = withSharedRole(someone, 'p1', role);
      expect(sharedActionsOf(member, 'p1'), role).toEqual(SHARED_EXPECTED[role]);
      expect(sharedActionsOf(member, 'p2'), role).toEqual([]);
    }
    expect(sharedActionsOf(operator, 'p1')).toEqual([]);
  });

  it('replaces a member\'s role rather than adding a second one', () => {
    const member = withSharedRole(withSharedRole(someone, 'p1', 'owner'), 'p1', 'client');
    expect(sharedActionsOf(member, 'p1')).toEqual(SHARED_EXPECTED.client);
  });

  it('refuses a shared action with the table\'s sentence', () => {
    expect(authorize(withSharedRole(someone, 'p1', 'client'), 'invite', { kind: 'shared-project', id: 'p1' }))
      .toEqual({ allowed: false, status: 403, error: 'Only an owner can invite people to this project.' });
  });
});
