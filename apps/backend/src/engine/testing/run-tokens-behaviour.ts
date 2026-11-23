import { describe, expect, it } from 'vitest';
import type { Database } from '../../platform/lib/db-interface.js';
import { stillDown, type Reopening } from '../../platform/index.js';
import { asPerson } from '../../platform/lib/permissions.js';
import { RunTokens, type RunTokenRoot } from '../services/RunTokens.js';
import type { RunGrant } from '../lib/run-grants.js';

const DATA_KEY = 'run-tokens-test-key';

interface Issued { runId: string; space?: string | undefined; refresh: string; live: boolean }

function rootOf(now: () => number) {
  const issued: Issued[] = [];
  let next = 0;
  const give = (runId: string, space: string | undefined) => {
    const n = ++next;
    issued.push({ runId, space, refresh: `refresh-${n}`, live: true });
    return { accessToken: `access-${n}`, refreshToken: `refresh-${n}`, expiresAt: now() + 300_000 };
  };
  const root: RunTokenRoot = {
    async runToken(runId, space) {
      return give(runId, space);
    },
    async renewRunToken(refreshToken) {
      const held = issued.find((one) => one.refresh === refreshToken);
      if (!held?.live) throw new Error('root renewed no run token: grant request is invalid');
      held.live = false;
      return give(held.runId, held.space);
    },
    async endRunToken(refreshToken) {
      const held = issued.find((one) => one.refresh === refreshToken);
      if (held) held.live = false;
    },
  };
  return { root, issued, live: () => issued.filter((one) => one.live) };
}

const never: Reopening = { seconds: 0, later: () => setTimeout(() => undefined, 0), reset: () => undefined } as unknown as Reopening;

export function runTokensBehaviour(database: () => Promise<Pick<Database, 'engine'>>): void {
  const grant = (id: string, over: Partial<RunGrant> = {}): RunGrant => ({
    id, ownerId: 'owner', personId: 'owner', runId: `run-${id}`, principal: asPerson('owner'), scope: {}, startedBy: 'person', state: 'live', issuedAt: '2026-11-21T10:00:00.000Z', ...over,
  });

  async function keeper(holder = 'worker-1') {
    const db = await database();
    let clock = Date.parse('2026-11-21T10:00:00Z');
    const now = () => clock;
    const root = rootOf(now);
    const logged: string[] = [];
    const refused: string[] = [];
    const refusals = { refused: (dependency: string, reason: string) => { refused.push(`${dependency}: ${reason}`); } };
    const tokens = (as: string) => new RunTokens({ store: db.engine, root: root.root, dataKey: DATA_KEY, holder: as, now, log: (message) => logged.push(message), again: () => never, refusals });
    const endingWith = (endRunToken: RunTokenRoot['endRunToken']) => new RunTokens({ store: db.engine, root: { ...root.root, endRunToken }, dataKey: DATA_KEY, holder: 'worker-1', log: (message) => logged.push(message), again: () => never, refusals });
    return { db, root, tokens: tokens(holder), another: tokens('worker-2'), endingWith, logged, refused, refusals, pass: (ms: number) => { clock += ms; } };
  }

  describe('the run tokens a Koala holds for its runs', () => {
    it('gets a run its token from root once, gives it to every call until it nears its end, then renews it with the refresh token root rotated', async () => {
      const { db, root, tokens, pass } = await keeper();
      await db.engine.saveRunGrant(grant('g1'));
      const [first, again] = await Promise.all([tokens.bearerFor('g1'), tokens.bearerFor('g1')]);
      expect(first).toBe('access-1');
      expect(again).toBe('access-1');
      expect(await tokens.bearerFor('g1')).toBe('access-1');
      expect(root.issued).toEqual([{ runId: 'run-g1', space: undefined, refresh: 'refresh-1', live: true }]);

      pass(290_000);
      expect(await tokens.bearerFor('g1')).toBe('access-2');
      expect(root.live().map((one) => one.refresh)).toEqual(['refresh-2']);
      const [kept] = await db.engine.getRunGrantTokens('g1');
      expect(kept).toMatchObject({ turn: 2 });
      expect(JSON.stringify(kept)).not.toContain('refresh-2');
      expect(JSON.stringify(kept)).not.toContain('access-2');
    });

    it('names the check space: the one a check run asks for, and the space a run inside one acts as', async () => {
      const { db, root, tokens } = await keeper();
      await db.engine.saveRunGrant(grant('check'));
      await db.engine.saveRunGrant(grant('inside', { personId: 'space-b', principal: { kind: 'person', id: 'space-b', claims: [{ role: 'person' }, { role: 'space-of', person: 'owner' }] } }));
      expect(await tokens.bearerFor('check', 'space-a')).not.toBe(await tokens.bearerFor('check'));
      await tokens.bearerFor('inside');
      expect(root.issued.map(({ runId, space }) => ({ runId, space }))).toEqual([
        { runId: 'run-check', space: 'space-a' },
        { runId: 'run-check', space: undefined },
        { runId: 'run-inside', space: 'space-b' },
      ]);
      await expect(tokens.bearerFor('inside', 'space-c')).rejects.toThrow(/acts as space space-b, not space-c/);
    });

    it('finds a run\'s grant by the run, for work that knows only the run it belongs to', async () => {
      const { db, root, tokens } = await keeper();
      await db.engine.saveRunGrant(grant('check'));
      expect(await tokens.bearerForRun('run-check', 'space-a')).toBe(await tokens.bearerFor('check', 'space-a'));
      expect(root.issued).toHaveLength(1);
      await expect(tokens.bearerForRun('run-never')).rejects.toThrow('run run-never holds no grant here, so it holds no token');
    });

    it('gives no token for a run whose grant ended, was revoked or is not known here, and asks root for none', async () => {
      const { db, root, tokens } = await keeper();
      await db.engine.saveRunGrant(grant('ended', { state: 'ended' }));
      await db.engine.saveRunGrant(grant('revoked', { state: 'revoked', revokedBecause: 'signed-out-everywhere' }));
      await expect(tokens.bearerFor('ended')).rejects.toThrow(/run run-ended has ended, so it holds no token/);
      await expect(tokens.bearerFor('revoked')).rejects.toThrow(/run run-revoked's access was taken away, so it holds no token/);
      await expect(tokens.bearerFor('never')).rejects.toThrow(/grant never is not known here/);
      expect(root.issued).toEqual([]);
    });

    it('hands back to root a token it got while the run\'s grant ended, keeping none', async () => {
      const { db, root, refusals } = await keeper();
      await db.engine.saveRunGrant(grant('g1'));
      const ending = new RunTokens({
        store: db.engine,
        root: { ...root.root, runToken: async (runId, space) => { const got = await root.root.runToken(runId, space); await db.engine.saveRunGrant(grant('g1', { state: 'ended' })); return got; } },
        dataKey: DATA_KEY, holder: 'worker-1', log: () => undefined, refusals,
      });
      await expect(ending.bearerFor('g1')).rejects.toThrow(/ended while its token was got/);
      expect(root.live()).toEqual([]);
      expect(await db.engine.getRunGrantTokens('g1')).toEqual([]);
    });

    it('revokes every holder\'s token at root when the run\'s grant ends, and keeps none', async () => {
      const { db, root, tokens, another } = await keeper();
      await db.engine.saveRunGrant(grant('g1'));
      await tokens.bearerFor('g1');
      await another.bearerFor('g1');
      await tokens.bearerFor('g1', 'space-a');
      expect(root.live()).toHaveLength(3);
      await db.engine.saveRunGrant(grant('g1', { state: 'ended' }));
      expect(await tokens.ended('g1')).toBe(true);
      expect(root.live()).toEqual([]);
      expect(await db.engine.getRunGrantTokens('g1')).toEqual([]);
    });

    it('keeps trying to revoke a run\'s token while root cannot be reached, and says so', async () => {
      const { db, root, logged, refused, endingWith } = await keeper();
      await db.engine.saveRunGrant(grant('g1'));
      let down = true;
      const flaky = endingWith(async (refresh) => { if (down) throw stillDown('root is not answering'); await root.root.endRunToken(refresh); });
      await flaky.bearerFor('g1');
      await db.engine.saveRunGrant(grant('g1', { state: 'ended' }));
      expect(await flaky.ended('g1')).toBe(false);
      expect(logged.join('\n')).toMatch(/root has not revoked run g1's token yet: root is not answering/);
      expect(await db.engine.getRunGrantTokens('g1')).toHaveLength(1);
      down = false;
      expect(await flaky.ended('g1')).toBe(true);
      expect(root.live()).toEqual([]);
      expect(refused).toEqual([]);
    });

    it('stops revoking a run\'s token once root refuses for good, keeping it and holding root as refused', async () => {
      const { db, refused, endingWith } = await keeper();
      await db.engine.saveRunGrant(grant('g1'));
      const refusing = endingWith(async () => { throw Object.assign(new Error('server responded with an error in the response body'), { name: 'ResponseBodyError', status: 401, error: 'invalid_client' }); });
      await refusing.bearerFor('g1');
      await db.engine.saveRunGrant(grant('g1', { state: 'ended' }));
      expect(await refusing.ended('g1')).toBe(false);
      expect(refused).toEqual(['root: revoking run g1\'s token: it refused: server responded with an error in the response body']);
      expect(await db.engine.getRunGrantTokens('g1')).toHaveLength(1);
    });

    it('takes a token root no longer knows as revoked, and keeps none', async () => {
      const { db, refused, endingWith } = await keeper();
      await db.engine.saveRunGrant(grant('g1'));
      const gone = endingWith(async () => { throw Object.assign(new Error('server responded with an error in the response body'), { name: 'ResponseBodyError', status: 400, error: 'invalid_token' }); });
      await gone.bearerFor('g1');
      await db.engine.saveRunGrant(grant('g1', { state: 'ended' }));
      expect(await gone.ended('g1')).toBe(true);
      expect(await db.engine.getRunGrantTokens('g1')).toEqual([]);
      expect(refused).toEqual([]);
    });

    it('revokes, as it starts, the tokens of runs that ended while no keeper was there to', async () => {
      const { db, root, tokens } = await keeper();
      await db.engine.saveRunGrant(grant('done'));
      await db.engine.saveRunGrant(grant('running'));
      await tokens.bearerFor('done');
      await tokens.bearerFor('running');
      await db.engine.saveRunGrant(grant('done', { state: 'ended' }));
      expect(await tokens.endLeftovers()).toBe(1);
      expect(root.live().map((one) => one.runId)).toEqual(['run-running']);
      expect(await db.engine.getRunGrantsHoldingTokens()).toEqual(['running']);
    });

    it('says why a Koala with no root to ask gives no run a token', async () => {
      const { db, refusals } = await keeper();
      await db.engine.saveRunGrant(grant('g1'));
      const none = new RunTokens({ store: db.engine, root: { none: 'root runs no runs of its own' }, dataKey: DATA_KEY, holder: 'root', log: () => undefined, refusals });
      await expect(none.bearerFor('g1')).rejects.toThrow('root runs no runs of its own');
      expect(await none.ended('g1')).toBe(true);
    });
  });
}
