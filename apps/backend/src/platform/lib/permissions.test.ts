import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS, SHARED_ROLES, allowed, authorize, claimsOf, clusterResource, principalOf, sharedActionsOf, withSharedRole,
  type Principal, type Resource, type SharedAction, type SharedRole, sessionPermissions,
} from './permissions.js';

const person = (id: string, extra: Principal['claims'] = []): Principal => ({ kind: 'person', id, claims: [{ role: 'person' }, ...extra] });
const operator = person('op', [{ role: 'operator' }]);
const instanceOwner = person('owner', [{ role: 'operator' }, { role: 'instance-owner' }]);
const someone = person('someone');

describe('claimsOf', () => {
  it('gives the operator claim from the operator role on root, never on the hub', () => {
    expect(claimsOf({ id: 'a', roles: ['operator' as const] }, { role: 'root' })).toEqual([{ role: 'person' }, { role: 'operator' }]);
    expect(claimsOf({ id: 'a', roles: ['operator' as const] }, { role: 'hub' })).toEqual([{ role: 'person' }]);
    expect(claimsOf({ id: 'a' }, { role: 'root' })).toEqual([{ role: 'person' }]);
  });

  it('makes the instance owner the operator of their instance by its owner id, whatever role is stored', () => {
    expect(claimsOf({ id: 'owner' }, { role: 'instance', instanceOwnerId: 'owner' }))
      .toEqual([{ role: 'person' }, { role: 'operator' }, { role: 'instance-owner' }]);
    expect(claimsOf({ id: 'other', roles: ['operator' as const] }, { role: 'instance', instanceOwnerId: 'owner' })).toEqual([{ role: 'person' }]);
    expect(claimsOf({ id: 'owner', roles: ['operator' as const] }, { role: 'instance' })).toEqual([{ role: 'person' }]);
  });

  it('builds a principal with them', () => {
    expect(principalOf({ id: 'a', roles: ['operator' as const] }, { role: 'root' })).toEqual({ kind: 'person', id: 'a', claims: [{ role: 'person' }, { role: 'operator' }] });
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

  it('shows whether the platform\'s own services answer only to whoever runs this Koala, saying why to anyone else', () => {
    expect(allowed(operator, 'see-platform-dependencies', { kind: 'install' })).toBe(true);
    expect(allowed(person('owner', [{ role: 'instance-owner' }]), 'see-platform-dependencies', { kind: 'install' })).toBe(true);
    expect(authorize(someone, 'see-platform-dependencies', { kind: 'install' })).toEqual({ allowed: false, status: 403, error: 'Only whoever runs this Koala sees whether the services it depends on answer.' });
    expect(allowed(person('member', [{ role: 'shared', project: 'p1', as: 'owner' }]), 'see-platform-dependencies', { kind: 'install' })).toBe(false);
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

  it('keeps the cluster an instance runs in to its owner like any other, and from the operator who does not own it', () => {
    const koalas = clusterResource({ id: 'machine-desk', ownerId: 'owner' });
    for (const action of Object.keys(PERMISSIONS.cluster) as (keyof typeof PERMISSIONS.cluster)[]) {
      expect(allowed(instanceOwner, action, koalas), action).toBe(true);
      expect(authorize(someone, action, koalas), action).toMatchObject({ allowed: false, status: 404 });
      expect(allowed(operator, action, koalas), action).toBe(false);
    }
    expect(clusterResource({ id: 'machine-desk', ownerId: 'owner' })).toEqual({ kind: 'cluster', id: 'machine-desk', ownerId: 'owner' });
  });

  it('lets a check\'s space see and deploy to its own person\'s clusters only, and change or remove none', () => {
    const space = principalOf({ id: 'space-1', space: { person: 'owner' }, roles: ['operator'] }, { role: 'instance', instanceOwnerId: 'space-1' });
    expect(space.claims).toEqual([{ role: 'person' }, { role: 'space-of', person: 'owner' }]);
    const theirs = clusterResource({ id: 'machine-desk', ownerId: 'owner' });
    expect(allowed(space, 'see', theirs)).toBe(true);
    expect(allowed(space, 'deploy-to', theirs)).toBe(true);
    for (const action of ['see-everything', 'change', 'delete'] as const) expect(authorize(space, action, theirs), action).toMatchObject({ allowed: false, status: 404 });
    for (const action of ['see', 'deploy-to'] as const) expect(authorize(space, action, clusterResource({ id: 'machine-other', ownerId: 'someone-else' })), action).toMatchObject({ allowed: false, status: 404 });
    expect(allowed(space, 'see', clusterResource({ id: 'machine-nobody' }))).toBe(false);
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

describe('what the session says a person may do', () => {
  const on = (role: 'root' | 'instance' | 'hub', roles: ('operator')[] = []) =>
    principalOf({ id: 'me', roles }, { role, instanceOwnerId: role === 'instance' ? 'me' : undefined });

  it('gives an instance\'s owner its settings and the operator\'s powers there, but no accounts to manage', () => {
    expect(sessionPermissions(on('instance'), { holdsAccounts: false })).toEqual({
      administer: true, 'manage-accounts': false, 'see-all-work': true, 'open-platform-namespaces': true, 'change-instance-settings': true, 'manage-own-account': false,
    });
  });

  it('lets root\'s operator manage accounts and anyone remove their own account where accounts are held', () => {
    expect(sessionPermissions(on('root', ['operator']), { holdsAccounts: true })['manage-accounts']).toBe(true);
    expect(sessionPermissions(on('root'), { holdsAccounts: true })).toEqual({
      administer: false, 'manage-accounts': false, 'see-all-work': false, 'open-platform-namespaces': false, 'change-instance-settings': false, 'manage-own-account': true,
    });
  });

  it('gives nobody on the hub an operator\'s power, whatever role is stored', () => {
    expect(Object.values(sessionPermissions(on('hub', ['operator']), { holdsAccounts: false })).some(Boolean)).toBe(false);
  });
});
