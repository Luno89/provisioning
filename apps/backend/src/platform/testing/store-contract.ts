import { describe, expect, it } from 'vitest';
import type { LockoutRule } from '../lib/http-limits.js';
import type { PlatformStore } from '../store.js';

const T = Date.now();
const RULE: LockoutRule = { after: 3, windowMs: 60_000, forMs: 120_000 };

export function platformStoreContract(make: () => Promise<PlatformStore>): void {
  describe('the state of the dependencies each process uses', () => {
    it('keeps one row per process and dependency, the last written', async () => {
      const store = await make();
      await store.saveDependencyState({ process: 'worker-engine', dependency: 'gitea', state: 'down', since: '2026-11-08T10:00:00.000Z', reason: 'it refused the connection (ECONNREFUSED)', at: '2026-11-08T10:00:00.000Z' });
      await store.saveDependencyState({ process: 'worker-cluster', dependency: 'gitea', state: 'answering', at: '2026-11-08T10:00:01.000Z' });
      await store.saveDependencyState({ process: 'worker-engine', dependency: 'gitea', state: 'answering', at: '2026-11-08T10:05:00.000Z' });
      const rows = [...await store.dependencyStates()].sort((a, b) => a.process.localeCompare(b.process));
      expect(rows).toEqual([
        { process: 'worker-cluster', dependency: 'gitea', state: 'answering', at: '2026-11-08T10:00:01.000Z' },
        { process: 'worker-engine', dependency: 'gitea', state: 'answering', at: '2026-11-08T10:05:00.000Z' },
      ]);
    });

    it('gives back a down row with when it went down and why', async () => {
      const store = await make();
      await store.saveDependencyState({ process: 'worker-host', dependency: 'searxng', state: 'down', since: '2026-11-08T10:00:00.000Z', reason: 'it answered 503', at: '2026-11-08T10:00:00.000Z' });
      expect(await store.dependencyStates()).toEqual([{ process: 'worker-host', dependency: 'searxng', state: 'down', since: '2026-11-08T10:00:00.000Z', reason: 'it answered 503', at: '2026-11-08T10:00:00.000Z' }]);
    });
  });

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

  describe('browsers\' sessions', () => {
    const held = (sub: string, rootSid: string) => ({
      cookie: { originalMaxAge: 60_000, expires: new Date(Date.now() + 60_000).toISOString(), httpOnly: true, path: '/' },
      person: { sub, email: `${sub}@example.com`, claims: [{ role: 'person' }], sessionAt: 1, accessExp: 2, rootSid, tokens: { access: 'a', refresh: 'r', id: 'i' } },
    });
    const put = (store: PlatformStore, id: string, value: unknown) => new Promise<void>((resolve, reject) => { store.browserSessions().set(id, value as never, (err) => (err ? reject(err as Error) : resolve())); });
    const got = (store: PlatformStore, id: string) => new Promise<unknown>((resolve, reject) => { store.browserSessions().get(id, (err, value) => (err ? reject(err as Error) : resolve(value ?? undefined))); });

    it('keeps a session by its id alone and gives back what it holds', async () => {
      const store = await make();
      await put(store, 'b1', held('ann', 'root-1'));
      expect(await got(store, 'b1')).toMatchObject({ person: { sub: 'ann', rootSid: 'root-1', tokens: { refresh: 'r' } } });
      expect(await got(store, 'never-made')).toBeUndefined();
    });

    it('ends every session of a person, or every session of one sign-in at root, and leaves the others alone', async () => {
      const store = await make();
      await put(store, 'b1', held('ann', 'root-1'));
      await put(store, 'b2', held('ann', 'root-2'));
      await put(store, 'b3', held('bob', 'root-3'));
      await put(store, 'b4', held('ann', 'root-1'));
      expect((await store.endBrowserSessions({ rootSid: 'root-1' })).sort()).toEqual(['b1', 'b4']);
      expect([await got(store, 'b1'), await got(store, 'b2')]).toEqual([undefined, expect.objectContaining({})]);
      expect(await store.endBrowserSessions({ sub: 'ann' })).toEqual(['b2']);
      expect(await got(store, 'b3')).toMatchObject({ person: { sub: 'bob' } });
      expect(await store.endBrowserSessions({ sub: 'nobody' })).toEqual([]);
    });

    it('ends the sessions root holds for an account signed in on root itself with the rest of that person\'s', async () => {
      const store = await make();
      await put(store, 'r1', { cookie: held('ann', 'x').cookie, account: { sub: 'ann', sessionAt: 1 } });
      await put(store, 'r2', { cookie: held('bob', 'x').cookie, account: { sub: 'bob', sessionAt: 1 } });
      await put(store, 'b1', held('ann', 'root-1'));
      expect((await store.endBrowserSessions({ sub: 'ann' })).sort()).toEqual(['b1', 'r1']);
      expect(await got(store, 'r2')).toMatchObject({ account: { sub: 'bob' } });
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
