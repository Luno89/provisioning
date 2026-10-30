import { describe, expect, it } from 'vitest';
import { EndedSessionList } from './ended-sessions.js';

describe('the list of sessions signed out of', () => {
  it('refuses a session it holds until that session would have expired anyway', () => {
    const list = new EndedSessionList();
    list.add({ id: 's1', until: 2_000, at: 100 });
    expect(list.ended('s1', 1_999)).toBe(true);
    expect(list.ended('s1', 2_000)).toBe(false);
    expect(list.ended('s2', 1_000)).toBe(false);
  });

  it('keeps the later of two ends for one session, and remembers how far it has read', () => {
    const list = new EndedSessionList();
    list.load([{ id: 's1', until: 5_000, at: 300 }, { id: 's1', until: 2_000, at: 200 }]);
    expect(list.ended('s1', 4_000)).toBe(true);
    expect(list.seenUpTo).toBe(300);
  });

  it('forgets what has expired when pruned', () => {
    const list = new EndedSessionList();
    list.load([{ id: 'old', until: 1_000, at: 1 }, { id: 'new', until: 9_000, at: 2 }]);
    list.prune(5_000);
    expect(list.size).toBe(1);
    expect(list.ended('new', 5_000)).toBe(true);
  });
});
