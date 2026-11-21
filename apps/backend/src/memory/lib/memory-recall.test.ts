import { describe, it, expect } from 'vitest';
import { dnsMemory } from '../testing/memories.js';
import { recalledInOrder, roomForMemories } from './memory-recall.js';

describe('the memories a run is given, in the index\'s order', () => {
  const first = dnsMemory({ id: 'first' });
  const second = dnsMemory({ id: 'second' });

  it('follows the index\'s ranking, not when the memories were made', () => {
    expect(recalledInOrder([first, second], ['second', 'first']).map((memory) => memory.id)).toEqual(['second', 'first']);
  });

  it('leaves out what the index found that the person no longer has, and what it did not find', () => {
    expect(recalledInOrder([first, second], ['gone', 'first']).map((memory) => memory.id)).toEqual(['first']);
  });
});

describe('the room a model\'s context has for memories', () => {
  it('is the window less the margin and the smallest reply, at four characters a token', () => {
    expect(roomForMemories(2_000)).toBe((2_000 - 1_000 - 512) * 4);
  });

  it('is none when the window is smaller than the margin and the smallest reply', () => {
    expect(roomForMemories(1_000)).toBe(0);
  });
});
