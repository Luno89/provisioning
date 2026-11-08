import { describe, it, expect } from 'vitest';
import { allowed, asPerson, clusterResource, principalOf } from '../../platform/lib/permissions.js';

describe('cluster room visibility', () => {
  const alice = asPerson('user-alice');

  it('lets an owner in', () => {
    expect(allowed(alice, 'see', clusterResource({ id: 'c1', ownerId: 'user-alice' }))).toBe(true);
  });

  it('keeps another tenant out', () => {
    expect(allowed(alice, 'see', clusterResource({ id: 'c1', ownerId: 'user-bob' }))).toBe(false);
  });

  it('lets nobody but its owner into the room of the cluster an instance runs in, operator or not, its provisioning log included', () => {
    const koalas = clusterResource({ id: 'machine-desk', ownerId: 'user-bob' });
    expect(allowed(alice, 'see', koalas)).toBe(false);
    expect(allowed(principalOf({ id: 'user-admin', roles: ['operator' as const] }, { role: 'root' }), 'see-everything', koalas)).toBe(false);
    expect(allowed(asPerson('user-bob'), 'see-everything', koalas)).toBe(true);
  });
});

describe('project ownership', () => {
  const alice = principalOf({ id: 'user-alice' }, { role: 'root' });
  const admin = principalOf({ id: 'user-admin', roles: ['operator' as const] }, { role: 'root' });
  const project = (ownerId?: string) => ({ kind: 'project' as const, ownerId });

  it('lets an owner in', () => {
    expect(allowed(alice, 'see', project('user-alice'))).toBe(true);
  });

  it('keeps another tenant out, including an admin, since ownership is explicit', () => {
    expect(allowed(alice, 'see', project('user-bob'))).toBe(false);
    expect(allowed(admin, 'see', project('user-bob'))).toBe(false);
  });

  it('gives a project with no owner, or an empty one, to nobody; the startup migration gives every one an owner', () => {
    expect(allowed(alice, 'see', project())).toBe(false);
    expect(allowed(admin, 'see', project())).toBe(false);
    expect(allowed(admin, 'see', project(''))).toBe(false);
  });
});
