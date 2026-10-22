import { describe, it, expect, beforeAll } from 'vitest';
import type { MongoDB } from './mongo-db.js';
import { testDatabase } from './test-database.js';
import { TREE_TYPE_SEEDS } from '../../projects/lib/tree-type-seeds.js';
import type { TreeTypeSpec } from '../../projects/lib/tree-types.js';

let db: MongoDB;
const OWNERS = ['roundtrip-owner-a', 'roundtrip-owner-b'];

const owned = async (owner: string) =>
  (await db.projects.getTreeTypes(owner)).filter((t) => t.ownerId === owner);

beforeAll(async () => {
  db = await testDatabase();
});

describe('tree types in real Mongo', () => {
  it('gives back the id it was given, not the storage key', async () => {
    const seed = { ...TREE_TYPE_SEEDS[0]!, ownerId: OWNERS[0]! };
    await db.projects.saveTreeType(seed);

    const back = await owned(OWNERS[0]!);
    expect(back).toHaveLength(1);
    expect(back[0]!.id).toBe(seed.id);
    expect(back[0]!.language).toBe(seed.language);
    expect(back[0]!.produces).toBe(seed.produces);
    expect(back[0]!.files.length).toBe(seed.files.length);
  });

  it('is idempotent, which is what seeding on every read depends on', async () => {
    const seed = { ...TREE_TYPE_SEEDS[0]!, ownerId: OWNERS[0]! };
    await db.projects.saveTreeType(seed);
    await db.projects.saveTreeType({ ...seed, label: 'Edited' });
    const back = await owned(OWNERS[0]!);
    expect(back).toHaveLength(1);
    expect(back[0]!.label).toBe('Edited');
  });

  it('keeps two owners\' identically-named types apart', async () => {
    await db.projects.saveTreeType({ ...TREE_TYPE_SEEDS[0]!, ownerId: OWNERS[0]!, label: 'Mine' });
    await db.projects.saveTreeType({ ...TREE_TYPE_SEEDS[0]!, ownerId: OWNERS[1]!, label: 'Theirs' });
    expect((await owned(OWNERS[0]!))[0]!.label).toBe('Mine');
    expect((await owned(OWNERS[1]!))[0]!.label).toBe('Theirs');
  });

  it('deletes only the owner it was asked about', async () => {
    await db.projects.saveTreeType({ ...TREE_TYPE_SEEDS[1]! } as TreeTypeSpec);
    await db.projects.saveTreeType({ ...TREE_TYPE_SEEDS[0]!, ownerId: OWNERS[0]! });
    await db.projects.saveTreeType({ ...TREE_TYPE_SEEDS[0]!, ownerId: OWNERS[1]! });
    await db.projects.deleteTreeType(TREE_TYPE_SEEDS[0]!.id, OWNERS[0]!);
    expect(await owned(OWNERS[0]!)).toHaveLength(0);
    expect(await owned(OWNERS[1]!)).toHaveLength(1);

    expect((await db.projects.getTreeTypes(OWNERS[0])).some((t) => t.ownerId == null)).toBe(true);
  });
});

describe('model thinking profiles in real Mongo', () => {
  const MODEL = 'roundtrip-probe-model';
  const profile = {
    modelId: MODEL,
    successSamples: 3, failureSamples: 1,
    avgSuccessEntropy: 0.5, avgFailureEntropy: 0.9,
    avgSuccessRepetition: 0.1, avgFailureRepetition: 0.4,
    avgSuccessThoughtLength: 120, avgFailureThoughtLength: 900,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('round-trips without inventing an id', async () => {
    await db.models.saveModelThinkingProfile(profile as never);
    const back = await db.models.getModelThinkingProfile(MODEL);
    expect(back?.modelId).toBe(MODEL);
    expect(back?.avgSuccessEntropy).toBe(0.5);
    expect(back as unknown as Record<string, unknown>).not.toHaveProperty('id');
  });

  it('upserts on the model rather than accumulating rows', async () => {
    await db.models.saveModelThinkingProfile(profile as never);
    await db.models.saveModelThinkingProfile({ ...profile, successSamples: 9 } as never);
    expect((await db.models.getModelThinkingProfile(MODEL))?.successSamples).toBe(9);
  });
});

describe('binding types in real Mongo', () => {
  const TEST_ID = 'roundtrip-test-binding';

  afterAll(async () => {
    await db.deleteBindingType(TEST_ID).catch(() => undefined);
  });

  it('saves, retrieves, and deletes dynamic binding types', async () => {
    await db.saveBindingType({
      id: TEST_ID,
      label: 'Roundtrip Test Service',
      protocol: 'http',
      defaultPort: 9999,
      description: 'Dynamic binding type verification',
    });

    const list = await db.getBindingTypes();
    const found = list.find((b) => b.id === TEST_ID);
    expect(found).toBeDefined();
    expect(found?.label).toBe('Roundtrip Test Service');
    expect(found?.defaultPort).toBe(9999);

    await db.deleteBindingType(TEST_ID);
    const after = await db.getBindingTypes();
    expect(after.find((b) => b.id === TEST_ID)).toBeUndefined();
  });
});

describe('join tokens in real Mongo', () => {
  it('give back whether they move an instance, once', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await db.instances.saveJoinToken({ hash: 'roundtrip-move-token', ownerId: OWNERS[0]!, instanceId: 'roundtrip-instance', expiresAt, move: true });
    await db.instances.saveJoinToken({ hash: 'roundtrip-join-token', ownerId: OWNERS[0]!, instanceId: 'roundtrip-instance', expiresAt });
    expect(await db.instances.takeJoinToken('roundtrip-move-token')).toEqual({ hash: 'roundtrip-move-token', ownerId: OWNERS[0], instanceId: 'roundtrip-instance', expiresAt, move: true });
    expect(await db.instances.takeJoinToken('roundtrip-join-token')).toEqual({ hash: 'roundtrip-join-token', ownerId: OWNERS[0], instanceId: 'roundtrip-instance', expiresAt });
    expect(await db.instances.takeJoinToken('roundtrip-move-token')).toBeUndefined();
  });
});
