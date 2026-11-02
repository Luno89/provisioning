import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { memoryDatabase } from '../testing/memory-database.js';
import { SessionEnds } from './SessionEnds.js';

describe('the sessions signed out of', () => {
  it('are refused at once, kept in the store, and refused again by a process that starts later', async () => {
    const db = memoryDatabase();
    const now = Date.now();
    const here = new SessionEnds(db.platform);
    await here.end('jti-1', now + 60_000);
    expect(here.ended('jti-1')).toBe(true);
    expect(here.ended('jti-2')).toBe(false);
    const restarted = new SessionEnds(db.platform);
    expect(restarted.ended('jti-1')).toBe(false);
    await restarted.load();
    expect(restarted.ended('jti-1')).toBe(true);
  });

  it('tells each listener once when a session is first heard to have ended, and not again for the same one', async () => {
    const ends = new SessionEnds(memoryDatabase().platform, () => 1_000);
    const heard: string[] = [];
    ends.onEnd((id) => heard.push(id));
    ends.onEnd((id) => heard.push(`also ${id}`));
    await ends.end('jti-1', 5_000);
    await ends.end('jti-1', 6_000);
    await ends.end('jti-2', 5_000);
    expect(heard).toEqual(['jti-1', 'also jti-1', 'jti-2', 'also jti-2']);
  });

  it('forgets a session once it would have expired', async () => {
    let clock = 1_000;
    const ends = new SessionEnds(memoryDatabase().platform, () => clock);
    await ends.end('jti-1', 5_000);
    expect(ends.ended('jti-1')).toBe(true);
    clock = 5_001;
    expect(ends.ended('jti-1')).toBe(false);
  });
});

describe('reading the sessions another process signed out of', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('takes up a session a process beside it ended, and tells the listeners', async () => {
    const db = memoryDatabase();
    let clock = Date.now();
    const one = new SessionEnds(db.platform, () => clock);
    const other = new SessionEnds(db.platform, () => clock);
    await other.load();
    const heard: string[] = [];
    other.onEnd((id) => heard.push(id));
    other.keepReading(() => undefined, 20);
    await one.end('jti-3', clock + 120_000);
    await vi.advanceTimersByTimeAsync(25);
    other.stop();
    expect(other.ended('jti-3')).toBe(true);
    expect(heard).toEqual(['jti-3']);
    clock += 121_000;
    expect(other.ended('jti-3')).toBe(false);
  });

  it('says so, and goes on, when the store cannot be read', async () => {
    const store = mock<ConstructorParameters<typeof SessionEnds>[0]>();
    store.sessionsEndedSince.mockRejectedValue(new Error('store gone'));
    const lines: string[] = [];
    const ends = new SessionEnds(store);
    ends.keepReading((line) => lines.push(line), 20);
    ends.keepReading((line) => lines.push(line), 20);
    await vi.advanceTimersByTimeAsync(25);
    ends.stop();
    expect(lines).toEqual(['[sessions] could not read the sessions signed out of: store gone']);
    await vi.advanceTimersByTimeAsync(100);
    expect(lines).toHaveLength(1);
  });

  it('asks only for what is newer than what it has seen', async () => {
    const store = mock<ConstructorParameters<typeof SessionEnds>[0]>();
    store.sessionsEndedSince.mockResolvedValue([]);
    const ends = new SessionEnds(store, () => 500);
    await ends.end('jti-1', 9_000);
    ends.keepReading(() => undefined, 20);
    await vi.advanceTimersByTimeAsync(25);
    ends.stop();
    expect(store.sessionsEndedSince).toHaveBeenCalledWith(500);
  });
});
