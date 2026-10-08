import { describe, it, expect } from 'vitest';
import { modelOwner, reowned, spacePersonas, spacePractices, spaceUser } from './check-space.js';
import type { MemoryItem } from './memory-store.js';

describe('a check space', () => {
  it('is an account that says whose check it is, and borrows that person\'s models', () => {
    const user = spaceUser('space-1', { person: 'bo', checkRunId: 'c1', scenarioId: 's1' }, 'now');
    expect(user).toMatchObject({ id: 'space-1', email: 'space-1@checks.internal', space: { person: 'bo', checkRunId: 'c1', scenarioId: 's1' } });
    expect(user.passwordHash).toBeUndefined();
    expect(modelOwner(user, 'space-1')).toBe('bo');
    expect(modelOwner({ id: 'bo' }, 'bo')).toBe('bo');
  });

  it('starts from the person\'s own configuration, not the built-ins or anyone else\'s', () => {
    expect(reowned([{ id: 'a', ownerId: 'bo' }, { id: 'b' }, { id: 'c', ownerId: 'cy' }], 'bo', 'space-1')).toEqual([{ id: 'a', ownerId: 'space-1' }]);
  });

  it('applies a prompt change to its copy of the agent, starting from the built-in when the person has none', () => {
    const personas = [{ slug: 'koala', prompt: 'built in' }, { slug: 'judge', ownerId: 'bo', prompt: 'mine' }];
    expect(spacePersonas(personas, 'bo', 'space-1', { agent: 'koala', prompt: 'changed' })).toEqual([
      { slug: 'judge', ownerId: 'space-1', prompt: 'mine' },
      { slug: 'koala', ownerId: 'space-1', prompt: 'changed' },
    ]);
  });

  it('carries the person\'s live practices, and a practice on trial as live', () => {
    const practice = (id: string, over: Partial<MemoryItem>): MemoryItem => ({ id, ownerId: 'bo', title: id, text: id, category: 'practice', createdAt: '', updatedAt: '', ...over } as MemoryItem);
    const copied = spacePractices([
      practice('p1', { status: 'active' }), practice('p2', { status: 'trial' }), practice('p3', { status: 'trial' }), practice('p4', { status: 'active', invalidAt: 'then' }),
    ], 'bo', 'space-1', 'p2');
    expect(copied.map((memory) => [memory.id, memory.ownerId, memory.status])).toEqual([['space-1-p1', 'space-1', 'active'], ['space-1-p2', 'space-1', 'active']]);
  });
});
