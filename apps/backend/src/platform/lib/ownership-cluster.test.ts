import { describe, expect, it } from 'vitest';
import { clusterOwnership } from './ownership.js';

describe('who owns a cluster', () => {
  const system = { isSystem: true };
  const bos = { ownerId: 'bo' };

  it('a cluster of a person\'s own is theirs alone, admin or not', () => {
    const owns = clusterOwnership(undefined);
    expect(owns({ id: 'bo' }, bos)).toBe(true);
    expect(owns({ id: 'al' }, bos)).toBe(false);
    expect(owns({ id: 'al', isAdmin: true }, bos)).toBe(false);
    expect(owns({ id: 'al' }, {})).toBe(false);
  });

  it('combined, the system cluster is the admins\'', () => {
    const owns = clusterOwnership(undefined);
    expect(owns({ id: 'al', isAdmin: true }, system)).toBe(true);
    expect(owns({ id: 'bo' }, system)).toBe(false);
    expect(owns({ id: 'bo', isAdmin: false }, system)).toBe(false);
  });

  it('on an instance, the system cluster is the instance owner\'s, not an admin\'s', () => {
    const owns = clusterOwnership('bo');
    expect(owns({ id: 'bo' }, system)).toBe(true);
    expect(owns({ id: 'al', isAdmin: true }, system)).toBe(false);
    expect(owns({ id: 'al' }, { ownerId: 'al' })).toBe(true);
  });
});
