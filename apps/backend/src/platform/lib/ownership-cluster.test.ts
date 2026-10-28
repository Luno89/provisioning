import { describe, expect, it } from 'vitest';
import { allowed, clusterResource, principalOf } from './permissions.js';

describe('who sees all of a cluster', () => {
  const system = clusterResource({ id: 'sys', isSystem: true });
  const bos = clusterResource({ id: 'c', ownerId: 'bo' });
  const combined = (user: { id: string; isAdmin?: boolean }) => principalOf(user, { role: 'combined' });
  const onInstance = (user: { id: string; isAdmin?: boolean }) => principalOf(user, { role: 'instance', instanceOwnerId: 'bo' });

  it('a cluster of a person\'s own is theirs alone, admin or not', () => {
    expect(allowed(combined({ id: 'bo' }), 'see-everything', bos)).toBe(true);
    expect(allowed(combined({ id: 'al' }), 'see-everything', bos)).toBe(false);
    expect(allowed(combined({ id: 'al', isAdmin: true }), 'see-everything', bos)).toBe(false);
    expect(allowed(combined({ id: 'al' }), 'see-everything', clusterResource({ id: 'c' }))).toBe(false);
  });

  it('combined, the system cluster is the operator\'s', () => {
    expect(allowed(combined({ id: 'al', isAdmin: true }), 'see-everything', system)).toBe(true);
    expect(allowed(combined({ id: 'bo' }), 'see-everything', system)).toBe(false);
    expect(allowed(combined({ id: 'bo', isAdmin: false }), 'see-everything', system)).toBe(false);
  });

  it('on an instance, the system cluster is the instance owner\'s, not an admin\'s', () => {
    expect(allowed(onInstance({ id: 'bo' }), 'see-everything', system)).toBe(true);
    expect(allowed(onInstance({ id: 'al', isAdmin: true }), 'see-everything', system)).toBe(false);
    expect(allowed(onInstance({ id: 'al' }), 'see-everything', clusterResource({ id: 'c', ownerId: 'al' }))).toBe(true);
  });
});
