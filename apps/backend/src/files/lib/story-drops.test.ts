import { describe, expect, it } from 'vitest';
import { dropBranchName, dropSaid, waitingDrops, withDrop } from './story-drops.js';

const drop = (id: string, state: 'waiting' | 'merged' | 'conflict', paths = ['a.ts']) => ({ id, branch: dropBranchName('l1', id), paths, at: 't', by: 'u1', state });

describe('code dropped on a story', () => {
  it('is kept on the story as one drop per drop, the newest replacing an older of the same id', () => {
    expect(dropBranchName('l1', 's1')).toBe('drop/l1/s1');
    expect(withDrop([drop('a', 'waiting')], drop('a', 'merged')).map((entry) => entry.state)).toEqual(['merged']);
    expect(waitingDrops([drop('a', 'merged'), drop('b', 'waiting')]).map((entry) => entry.id)).toEqual(['b']);
  });

  it('says where it stands', () => {
    expect(dropSaid(drop('a', 'merged'))).toBe('a.ts merged into the story\'s checkout');
    expect(dropSaid(drop('a', 'waiting', ['a.ts', 'b.ts']))).toBe('2 files will be merged into the story\'s checkout when it is next made');
    expect(dropSaid({ ...drop('a', 'conflict'), conflicts: ['a.ts'] })).toMatch(/^a\.ts could not be merged into the story's checkout: a\.ts changed there too/);
  });
});
