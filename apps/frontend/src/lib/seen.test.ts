import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { lastSeen, markSeenAfterDwell, resetSeenCache } from './seen.js';

/**
 * The marker that tells a live board from a dead one.
 *
 * The bug being pinned here shipped and stayed invisible: under StrictMode the old unmount-cleanup
 * implementation stamped "seen" before anything had been read, so "N changes since you last looked"
 * was permanently zero. Nothing failed; the number was simply always right-looking and always
 * wrong. So these tests reproduce the StrictMode sequence directly.
 */

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
    // A date of 0 would report every leaf ever run as "changed since you last looked".
    expect(lastSeen('never', { storage: store() })).toBeUndefined();
  });

  it('does not observe a value this page itself wrote', () => {
    /**
     * The heart of it. A component that stamps the marker and then re-reads it — which is what a
     * remount does — must still see the ORIGINAL value, or it compares against itself.
     */
    const storage = store();
    storage.setItem('k', '2026-08-01T00:00:00Z');
    expect(lastSeen('k', { storage })).toBe('2026-08-01T00:00:00Z');

    markSeenAfterDwell('k', { storage, now: () => '2026-08-16T12:00:00Z' });
    vi.advanceTimersByTime(5000);
    expect(storage.getItem('k')).toBe('2026-08-16T12:00:00Z');

    // Re-read, as a remount would: still the original.
    expect(lastSeen('k', { storage })).toBe('2026-08-01T00:00:00Z');
  });
});

describe('surviving StrictMode', () => {
  it('does not mark seen during a mount/unmount/mount cycle', () => {
    /**
     * Exactly what React does in development: mount, tear down synchronously, mount again. The old
     * implementation wrote the marker on that first teardown, which is how the feature died.
     */
    const storage = store();
    storage.setItem('k', '2026-08-01T00:00:00Z');

    const cancelFirst = markSeenAfterDwell('k', { storage, now: () => 'NOW' });
    cancelFirst();                       // StrictMode's immediate teardown
    const cancelSecond = markSeenAfterDwell('k', { storage, now: () => 'NOW' });

    vi.advanceTimersByTime(100);
    expect(storage.getItem('k'), 'marked seen before anybody read anything').toBe('2026-08-01T00:00:00Z');

    // And the real mount still marks it, once the dwell has actually elapsed.
    vi.advanceTimersByTime(5000);
    expect(storage.getItem('k')).toBe('NOW');
    cancelSecond();
  });

  it('leaves the mark alone when you glance and leave', () => {
    // Opening a board and closing it immediately is not reading it. Stamping there would discard
    // changes you never saw.
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
