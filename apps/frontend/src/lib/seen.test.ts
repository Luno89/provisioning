import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { lastSeen, markSeenAfterDwell, resetSeenCache } from './seen.js';

const store = () => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
  };
};

beforeEach(() => { resetSeenCache(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe('reading the last-seen mark', () => {
  it('returns what was stored before this page ran', () => {
    const storage = store();
    storage.setItem('k', '2026-08-01T00:00:00Z');
    expect(lastSeen('k', { storage })).toBe('2026-08-01T00:00:00Z');
  });

  it('is undefined on a first ever visit, not the epoch', () => {
    expect(lastSeen('never', { storage: store() })).toBeUndefined();
  });

  it('does not observe a value this page itself wrote', () => {
    const storage = store();
    storage.setItem('k', '2026-08-01T00:00:00Z');
    expect(lastSeen('k', { storage })).toBe('2026-08-01T00:00:00Z');

    markSeenAfterDwell('k', { storage, now: () => '2026-08-16T12:00:00Z' });
    vi.advanceTimersByTime(5000);
    expect(storage.getItem('k')).toBe('2026-08-16T12:00:00Z');

    expect(lastSeen('k', { storage })).toBe('2026-08-01T00:00:00Z');
  });
});

describe('surviving StrictMode', () => {
  it('does not mark seen during a mount/unmount/mount cycle', () => {
    const storage = store();
    storage.setItem('k', '2026-08-01T00:00:00Z');

    const cancelFirst = markSeenAfterDwell('k', { storage, now: () => 'NOW' });
    cancelFirst();                       // StrictMode's immediate teardown
    const cancelSecond = markSeenAfterDwell('k', { storage, now: () => 'NOW' });

    vi.advanceTimersByTime(100);
    expect(storage.getItem('k'), 'marked seen before anybody read anything').toBe('2026-08-01T00:00:00Z');

    vi.advanceTimersByTime(5000);
    expect(storage.getItem('k')).toBe('NOW');
    cancelSecond();
  });

  it('leaves the mark alone when you glance and leave', () => {
    const storage = store();
    storage.setItem('k', 'ORIGINAL');
    const cancel = markSeenAfterDwell('k', { storage, now: () => 'NOW' });
    vi.advanceTimersByTime(500);
    cancel();
    vi.advanceTimersByTime(10_000);
    expect(storage.getItem('k')).toBe('ORIGINAL');
  });
});

describe('keys are independent', () => {
  it('does not let one board mark another as seen', () => {
    const storage = store();
    storage.setItem('tree-a', 'A');
    storage.setItem('tree-b', 'B');
    markSeenAfterDwell('tree-a', { storage, now: () => 'NOW' });
    vi.advanceTimersByTime(5000);
    expect(storage.getItem('tree-a')).toBe('NOW');
    expect(storage.getItem('tree-b')).toBe('B');
  });
});
