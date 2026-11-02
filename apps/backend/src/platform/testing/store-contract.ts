import { describe, expect, it } from 'vitest';
import type { LockoutRule } from '../lib/http-limits.js';
import type { PlatformStore } from '../store.js';

const T = Date.now();
const RULE: LockoutRule = { after: 3, windowMs: 60_000, forMs: 120_000 };
const byId = <Row extends { id: string }>(list: Row[]): Row[] => [...list].sort((a, b) => a.id.localeCompare(b.id));

export function platformStoreContract(make: () => Promise<PlatformStore>): void {
  describe('migrations that have run', () => {
    it('knows a migration only once it is recorded, and records it by its name', async () => {
      const store = await make();
      expect(await store.hasMigration('tidy-things')).toBe(false);
      await store.recordMigration({ name: 'tidy-things', at: '2026-10-01T00:00:00.000Z', result: { moved: 3 } });
      expect(await store.hasMigration('tidy-things')).toBe(true);
      expect(await store.hasMigration('other-thing')).toBe(false);
    });

    it('records a migration again without making a second one', async () => {
      const store = await make();
      await store.recordMigration({ name: 'tidy-things', at: '2026-10-01T00:00:00.000Z', result: { moved: 3 } });
      await store.recordMigration({ name: 'tidy-things', at: '2026-10-02T00:00:00.000Z', result: { moved: 0 } });
      expect(await store.hasMigration('tidy-things')).toBe(true);
    });
  });

  describe('sessions that were signed out', () => {
    it('tells whoever listens of each session signed out of, from any write, once it is listening', async () => {
      const store = await make();
      const now = Date.now();
      const heard: string[] = [];
      let both!: () => void;
      const done = new Promise<void>((resolve) => { both = resolve; });
      const watching = store.watchSessionEnds((ended) => { heard.push(`${ended.id} ${ended.until - now}`); if (heard.length === 2) both(); });
      await watching.ready;

      await store.endSession({ id: 's1', until: now + 60_000, at: now });
      await store.endSession({ id: 's2', until: now + 90_000, at: now });
      await done;
      await watching.close();

      expect(heard).toEqual(['s1 60000', 's2 90000']);
    });

    it('lists the sessions ended at or after a moment that have not yet expired', async () => {
      const store = await make();
      const now = Date.now();
      await store.endSession({ id: 'old', until: now + 60_000, at: now - 10_000 });
      await store.endSession({ id: 'edge', until: now + 60_000, at: now - 5_000 });
      await store.endSession({ id: 'recent', until: now + 60_000, at: now - 1_000 });
      expect(byId(await store.sessionsEndedSince(now - 5_000))).toEqual([
        { id: 'edge', until: now + 60_000, at: now - 5_000 },
        { id: 'recent', until: now + 60_000, at: now - 1_000 },
      ]);
      expect(byId(await store.sessionsEndedSince(0)).map((ended) => ended.id)).toEqual(['edge', 'old', 'recent']);
      expect(await store.sessionsEndedSince(now)).toEqual([]);
    });

    it('leaves out a session whose time to live has passed', async () => {
      const store = await make();
      const now = Date.now();
      await store.endSession({ id: 'lapsed', until: now - 1_000, at: now - 2_000 });
      await store.endSession({ id: 'live', until: now + 60_000, at: now - 2_000 });
      expect((await store.sessionsEndedSince(0)).map((ended) => ended.id)).toEqual(['live']);
    });

    it('ending a session again keeps the later expiry and takes the new moment it was ended', async () => {
      const store = await make();
      const now = Date.now();
      await store.endSession({ id: 's1', until: now + 120_000, at: now - 3_000 });
      await store.endSession({ id: 's1', until: now + 30_000, at: now - 1_000 });
      expect(await store.sessionsEndedSince(0)).toEqual([{ id: 's1', until: now + 120_000, at: now - 1_000 }]);
      await store.endSession({ id: 's1', until: now + 300_000, at: now - 500 });
      expect(await store.sessionsEndedSince(0)).toEqual([{ id: 's1', until: now + 300_000, at: now - 500 }]);
    });
  });

  describe('failed sign-in attempts', () => {
    it('has no attempts for a key that never failed', async () => {
      const store = await make();
      expect(await store.attemptsOf('account:ann')).toBeUndefined();
    });

    it('counts the first failure with nothing before it', async () => {
      const store = await make();
      const result = await store.countFailure('account:ann', T, RULE);
      expect(result).toEqual({ before: undefined, after: { failures: [T] } });
      expect(await store.attemptsOf('account:ann')).toEqual({ failures: [T] });
    });

    it('adds each failure to those before it and says what stood before', async () => {
      const store = await make();
      await store.countFailure('account:ann', T, RULE);
      const second = await store.countFailure('account:ann', T + 10000, RULE);
      expect(second).toEqual({ before: { failures: [T] }, after: { failures: [T, T + 10000] } });
      const third = await store.countFailure('account:ann', T + 20000, RULE);
      expect(third.before).toEqual({ failures: [T, T + 10000] });
      expect(await store.attemptsOf('account:ann')).toEqual({ failures: [T, T + 10000, T + 20000] });
    });

    it('lets failures older than the window go, the one exactly a window old included', async () => {
      const store = await make();
      await store.countFailure('account:ann', T, RULE);
      await store.countFailure('account:ann', T + 30000, RULE);
      const result = await store.countFailure('account:ann', T + 60000, RULE);
      expect(result.before).toEqual({ failures: [T, T + 30000] });
      expect(result.after).toEqual({ failures: [T + 30000, T + 60000] });
      expect(await store.attemptsOf('account:ann')).toEqual({ failures: [T + 30000, T + 60000] });
    });

    it('shows what stood before as it was kept, before the old failures were let go', async () => {
      const store = await make();
      await store.countFailure('account:ann', T, RULE);
      const later = await store.countFailure('account:ann', T + 1000000, RULE);
      expect(later.before).toEqual({ failures: [T] });
      expect(later.after).toEqual({ failures: [T + 1000000] });
    });

    it('keeps each key\'s attempts apart, and forgets a key when cleared', async () => {
      const store = await make();
      await store.countFailure('account:ann', T, RULE);
      await store.countFailure('browser:ann:1', T + 1000, RULE);
      await store.clearAttempts('account:ann');
      expect(await store.attemptsOf('account:ann')).toBeUndefined();
      expect(await store.attemptsOf('browser:ann:1')).toEqual({ failures: [T + 1000] });
      await store.clearAttempts('never');
      const again = await store.countFailure('account:ann', T + 2000, RULE);
      expect(again.before).toBeUndefined();
    });

    it('counts failures that arrive together without losing one', async () => {
      const store = await make();
      await Promise.all([1, 2, 3, 4, 5].map((step) => store.countFailure('account:ann', T + step, RULE)));
      expect((await store.attemptsOf('account:ann'))?.failures.slice().sort((a, b) => a - b)).toEqual([T + 1, T + 2, T + 3, T + 4, T + 5]);
    });

    it('hands back a copy of the attempts', async () => {
      const store = await make();
      const counted = await store.countFailure('account:ann', T, RULE);
      counted.after.failures.push(5);
      const read = await store.attemptsOf('account:ann');
      read!.failures.push(7);
      expect(await store.attemptsOf('account:ann')).toEqual({ failures: [T] });
    });
  });
}
