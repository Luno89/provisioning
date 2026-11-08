import { describe, expect, it } from 'vitest';
import { allowed, clusterResource, principalOf } from './permissions.js';

describe('who sees all of a cluster', () => {
  const bos = clusterResource({ id: 'c', ownerId: 'bo' });
  const onRoot = (user: { id: string; roles?: ('operator')[] }) => principalOf(user, { role: 'root' });
  const onInstance = (user: { id: string; roles?: ('operator')[] }) => principalOf(user, { role: 'instance', instanceOwnerId: 'bo' });

  it('a cluster of a person\'s own is theirs alone, operator or not', () => {
    expect(allowed(onRoot({ id: 'bo' }), 'see-everything', bos)).toBe(true);
    expect(allowed(onRoot({ id: 'al' }), 'see-everything', bos)).toBe(false);
    expect(allowed(onRoot({ id: 'al', roles: ['operator' as const] }), 'see-everything', bos)).toBe(false);
    expect(allowed(onRoot({ id: 'al' }), 'see-everything', clusterResource({ id: 'c' }))).toBe(false);
  });

  it('on an instance, the machine it runs on is its owner\'s like any other cluster of theirs, not someone else\'s with the operator role stored', () => {
    const koalas = clusterResource({ id: 'machine-desk', ownerId: 'bo' });
    expect(allowed(onInstance({ id: 'bo' }), 'see-everything', koalas)).toBe(true);
    expect(allowed(onInstance({ id: 'al', roles: ['operator' as const] }), 'see-everything', koalas)).toBe(false);
    expect(allowed(onInstance({ id: 'al' }), 'see-everything', clusterResource({ id: 'c', ownerId: 'al' }))).toBe(true);
  });
});
