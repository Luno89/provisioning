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

  it('lets everyone see the shared system cluster, and only its operator all of it, its provisioning log included', () => {
    const system = clusterResource({ id: 'provisioning-lunorica', isSystem: true });
    expect(allowed(alice, 'see', system)).toBe(true);
    expect(allowed(alice, 'see-everything', system)).toBe(false);
    expect(allowed(principalOf({ id: 'user-admin', isAdmin: true }, { role: 'combined' }), 'see-everything', system)).toBe(true);
  });
});

describe('project ownership', () => {
  const alice = principalOf({ id: 'user-alice', isAdmin: false }, { role: 'combined' });
  const admin = principalOf({ id: 'user-admin', isAdmin: true }, { role: 'combined' });
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
