import { describe, it, expect, afterAll } from 'vitest';
import { profileRouter } from './profile.js';
import { mountRouter, type Harness, TEST_USER } from '../test-harness.js';
import type { Database } from '../../lib/db-interface.js';
import { seedPacks } from '../../lib/pack-seeds.js';
import { seedPersonas } from '../../lib/persona-seeds.js';
import { deriveVariantPack } from '../../lib/derived-packs.js';
import type { Experiment, PersonaPack } from '@koala/harness-types';

const harness: Harness = await mountRouter({
  prefix: '/api/harness/profile',
  router: (db: Database) => profileRouter({ db, modelIdsFor: async () => undefined }),
});

await seedPersonas(harness.db as never);
await seedPacks(harness.db as never);

afterAll(async () => { await harness.close(); });

const koala = async () =>
  (await harness.db.getPersonaPacks()).find((p) => p.slug === 'koala')!;

/** Two runs of one arm, both verified, so it has a standing to promote. */
const experiment = async (armPack: PersonaPack): Promise<Experiment> => {
  const e: Experiment = {
    id: 'exp-1', ownerId: TEST_USER.id, name: 'rounds', language: 'node',
    tasks: [{ id: 't1', name: 'a', prompt: 'p', verifyCommand: 'v' }],
    variants: [{ label: 'more-rounds', packId: armPack.id }],
    repeats: 1, status: 'complete',
    results: [
      { label: 'more-rounds', taskId: 't1', succeeded: true, verified: true, tokensUsed: 1 },
      { label: 'more-rounds', taskId: 't1', succeeded: true, verified: true, tokensUsed: 1 },
    ] as never,
    createdAt: '', updatedAt: '',
  };
  await harness.db.saveExperiment(e);
  return e;
};

const post = async (path: string, body: unknown) => {
  const res = await fetch(harness.url(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
};

/**
 * Promotion overwrites the pack an arm came from, which is destructive — so this exercises the
 * whole route, not the fold in isolation. A user asked for exactly this rather than accumulating
 * ten versions of Koala, and "ask first" is the only thing standing between the two.
 */
describe('promoting an arm into the pack it came from', () => {
  const armWith = async (rounds: number) => {
    const base = await koala();
    const arm = deriveVariantPack(base, 'exp-1', 'more-rounds', { budget: { rounds } }, 'now');
    await harness.db.savePersonaPack(arm);
    return arm;
  };

  it('refuses without confirmation, and says what it would overwrite', async () => {
    await experiment(await armWith(12));

    const { status, body } = await post('/api/harness/profile/promote',
      { experimentId: 'exp-1', label: 'more-rounds' });

    expect(status).toBe(409);
    expect(body.confirmRequired).toBe(true);
    expect(body.target.name).toBe((await koala()).name);
    expect(body.changes).toContainEqual({ path: 'budget.rounds', from: 8, to: 12 });
  });

  it('leaves the pack untouched while it is unconfirmed', async () => {
    await experiment(await armWith(12));
    await post('/api/harness/profile/promote', { experimentId: 'exp-1', label: 'more-rounds' });

    expect((await koala()).budget.rounds).toBe(8);
  });

  it('overwrites that pack once confirmed, keeping its identity', async () => {
    const before = await koala();
    await experiment(await armWith(12));

    const { status } = await post('/api/harness/profile/promote',
      { experimentId: 'exp-1', label: 'more-rounds', confirm: true });

    const after = await koala();
    expect(status).toBe(200);
    expect(after.id).toBe(before.id);
    expect(after.slug).toBe('koala');
    expect(after.budget.rounds).toBe(12);
    expect(after.derivedFrom).toBeUndefined();
  });

  it('does not add a second pack — that is the whole point of overwriting', async () => {
    const own = (await harness.db.getPersonaPacks()).filter((p) => !p.derivedFrom);
    expect(own.filter((p) => p.slug === 'koala')).toHaveLength(1);
  });

  it('points the profile at the pack, and records the evidence', async () => {
    const res = await fetch(harness.url('/api/harness/profile'));
    const profile = await res.json() as any;

    expect(profile.packId).toBe((await koala()).id);
    expect(profile.from).toMatchObject({ experimentId: 'exp-1', variantLabel: 'more-rounds' });
  });
});
