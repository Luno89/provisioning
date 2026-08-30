import { describe, it, expect, afterAll } from 'vitest';
import { experimentsRouter } from './experiments.js';
import { mountRouter, type Harness } from '../test-harness.js';
import type { Database } from '../../lib/db-interface.js';
import { seedPacks } from '../../lib/pack-seeds.js';
import { seedPersonas } from '../../lib/persona-seeds.js';
import { seedWorkspaceImages } from '../../lib/workspace-image-seeds.js';

const harness: Harness = await mountRouter({
  prefix: '/api/harness/experiments',
  router: (db: Database) => experimentsRouter({
    db,
    experimentService: { isRunning: () => false } as never,
    modelIdsFor: async () => undefined,
  }),
});

await seedPersonas(harness.db as never);
await seedPacks(harness.db as never);
await seedWorkspaceImages(harness.db as never);

afterAll(async () => { await harness.close(); });

const create = async (body: Record<string, unknown>) => {
  const res = await fetch(harness.url('/api/harness/experiments'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'n', task: 't', verifyCommand: 'node t.js', ...body }),
  });
  return { status: res.status, body: await res.json() as any };
};

/**
 * The axis picker is how an experiment is normally authored. It produced variants carrying a bag of
 * overrides; an arm is a pack now, so each combination has to become one — and because `variants`
 * arrives untyped from the body, nothing but a test through the route catches it when it does not.
 */
describe('authoring an experiment from axes', () => {
  it('derives a pack for every combination, so each arm has something to run as', async () => {
    const { status, body } = await create({ axes: { temperature: [0.2, 0.9] } });

    expect(status).toBe(201);
    expect(body.variants).toHaveLength(2);
    for (const v of body.variants) expect(v.packId).toBeTruthy();
  });

  it('writes the axis value into the pack field the knob names', async () => {
    const { body } = await create({ axes: { temperature: [0.9] } });

    const packs = await harness.db.getPersonaPacks();
    const arm = packs.find((p) => p.id === body.variants[0].packId)!;
    expect(arm.sampling.toolTurn.temperature).toBe(0.9);
  });

  it('keeps the arms out of the pack list, so an experiment does not litter it', async () => {
    const { body } = await create({ axes: { temperature: [0.1, 0.5, 0.7] } });

    const packs = await harness.db.getPersonaPacks();
    for (const v of body.variants) {
      expect(packs.find((p) => p.id === v.packId)!.derivedFrom).toMatchObject({ experimentId: body.id });
    }
  });

  it('inherits everything it does not vary from the pack it was derived from', async () => {
    const { body } = await create({ axes: { temperature: [0.9] } });

    const packs = await harness.db.getPersonaPacks();
    const koala = packs.find((p) => p.slug === 'koala')!;
    const arm = packs.find((p) => p.id === body.variants[0].packId)!;
    expect(arm.budget).toEqual(koala.budget);
    expect(arm.tools).toEqual(koala.tools);
  });

  it('still accepts variants that name their own packs', async () => {
    const packs = await harness.db.getPersonaPacks();
    const koala = packs.find((p) => p.slug === 'koala')!;
    const { status, body } = await create({ variants: [{ label: 'a', packId: koala.id }] });

    expect(status).toBe(201);
    expect(body.variants[0].packId).toBe(koala.id);
  });

  it('refuses an arm that names no pack rather than running it against nothing', async () => {
    const { status, body } = await create({ variants: [{ label: 'a' }] });

    expect(status).toBe(400);
    expect(body.error).toMatch(/names no pack/i);
  });
});

describe('re-authoring an experiment from axes', () => {
  it('derives packs on edit too, not only on create', async () => {
    const { body: made } = await create({ variants: [{ label: 'a', packId: 'builtin-pack-koala' }] });

    const res = await fetch(harness.url(`/api/harness/experiments/${made.id}`), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ axes: { temperature: [0.15, 0.85] } }),
    });
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body.variants).toHaveLength(2);
    for (const v of body.variants) expect(v.packId).toBeTruthy();

    const packs = await harness.db.getPersonaPacks();
    const temps = body.variants.map((v: any) =>
      packs.find((p) => p.id === v.packId)!.sampling.toolTurn.temperature);
    expect(temps.sort()).toEqual([0.15, 0.85]);
  });
});
