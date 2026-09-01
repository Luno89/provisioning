import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoDB } from './mongo-db.js';
import { TREE_TYPE_SEEDS } from './tree-type-seeds.js';

const URI = process.env.MONGO_URI || 'mongodb://admin:admin@127.0.0.1:27017/provisioning?authSource=admin';
let reachable = false;
let db: MongoDB;
let raw: MongoClient;
const OWNERS = ['roundtrip-owner-a', 'roundtrip-owner-b'];

/**
 * `getTreeTypes(owner)` deliberately returns the owner's rows AND every built-in, so these
 * assertions have to be about what the OWNER has. Counting the whole result only ever worked on a
 * database with nothing seeded into it.
 */
const owned = async (owner: string) =>
  (await db.getTreeTypes(owner)).filter((t) => t.ownerId === owner);

beforeAll(async () => {
  try {
    raw = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 5000 });
    db = new MongoDB();
    await db.init();
    reachable = true;
  } catch {
    reachable = false;
  }
}, 15_000);

afterAll(async () => {
  if (!reachable) return;
  for (const owner of OWNERS) {
    for (const t of await db.getTreeTypes(owner)) await db.deleteTreeType(t.id, owner);
  }
  await raw.close();
});

describe.skipIf(!process.env.MONGO_URI && process.env.CI)('tree types in real Mongo', () => {
  it('gives back the id it was given, not the storage key', async () => {
    if (!reachable) return;
    const seed = { ...TREE_TYPE_SEEDS[0]!, ownerId: OWNERS[0]! };
    await db.saveTreeType(seed);

    const back = await owned(OWNERS[0]!);
    expect(back).toHaveLength(1);
    expect(back[0]!.id).toBe(seed.id);
    expect(back[0]!.language).toBe(seed.language);
    expect(back[0]!.produces).toBe(seed.produces);
    expect(back[0]!.files.length).toBe(seed.files.length);
  }, 15_000);

  it('is idempotent, which is what seeding on every read depends on', async () => {
    if (!reachable) return;
    const seed = { ...TREE_TYPE_SEEDS[0]!, ownerId: OWNERS[0]! };
    await db.saveTreeType(seed);
    await db.saveTreeType({ ...seed, label: 'Edited' });
    const back = await owned(OWNERS[0]!);
    expect(back).toHaveLength(1);
    expect(back[0]!.label).toBe('Edited');
  }, 15_000);

  it('keeps two owners\' identically-named types apart', async () => {
    if (!reachable) return;
    await db.saveTreeType({ ...TREE_TYPE_SEEDS[0]!, ownerId: OWNERS[0]!, label: 'Mine' });
    await db.saveTreeType({ ...TREE_TYPE_SEEDS[0]!, ownerId: OWNERS[1]!, label: 'Theirs' });
    expect((await owned(OWNERS[0]!))[0]!.label).toBe('Mine');
    expect((await owned(OWNERS[1]!))[0]!.label).toBe('Theirs');
  }, 15_000);

  it('deletes only the owner it was asked about', async () => {
    if (!reachable) return;
    await db.saveTreeType({ ...TREE_TYPE_SEEDS[0]!, ownerId: OWNERS[0]! });
    await db.saveTreeType({ ...TREE_TYPE_SEEDS[0]!, ownerId: OWNERS[1]! });
    await db.deleteTreeType(TREE_TYPE_SEEDS[0]!.id, OWNERS[0]!);
    expect(await owned(OWNERS[0]!)).toHaveLength(0);
    expect(await owned(OWNERS[1]!)).toHaveLength(1);

    // The built-ins a tenant reads alongside their own are untouched by their delete.
    expect((await db.getTreeTypes(OWNERS[0])).some((t) => t.ownerId == null)).toBe(true);
  }, 15_000);
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
    if (!reachable) return;
    await db.saveModelThinkingProfile(profile as never);
    const back = await db.getModelThinkingProfile(MODEL);
    expect(back?.modelId).toBe(MODEL);
    expect(back?.avgSuccessEntropy).toBe(0.5);
    expect(back as unknown as Record<string, unknown>).not.toHaveProperty('id');
  }, 15_000);

  it('upserts on the model rather than accumulating rows', async () => {
    if (!reachable) return;
    await db.saveModelThinkingProfile(profile as never);
    await db.saveModelThinkingProfile({ ...profile, successSamples: 9 } as never);
    expect((await db.getModelThinkingProfile(MODEL))?.successSamples).toBe(9);
  }, 15_000);
});

describe('binding types in real Mongo', () => {
  const TEST_ID = 'roundtrip-test-binding';

  afterAll(async () => {
    if (!reachable) return;
    await db.deleteBindingType(TEST_ID).catch(() => undefined);
  });

  it('saves, retrieves, and deletes dynamic binding types', async () => {
    if (!reachable) return;
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
  }, 15_000);
});
