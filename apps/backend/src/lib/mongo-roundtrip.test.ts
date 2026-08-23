import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoDB } from './mongo-db.js';
import { TREE_TYPE_SEEDS } from './tree-type-seeds.js';

/**
 * Round-trips through a REAL Mongo, because `MemoryDB` cannot fail the way Mongo does.
 *
 * ── THE BUG THAT MADE THIS FILE EXIST ──
 * `saveTreeType` built its document with `toDoc({ ...type, _id: `${ownerId}:${id}` })` — and
 * `toDoc`'s whole job is to set `_id` from `id`, so the composite key was overwritten a line after
 * it was written. Mongo refused every write with *"the (immutable) field '_id' was found to have
 * been altered"*, the route swallowed it into a `console.warn`, and `GET /api/tree-types` answered
 * `[]` to every user. Every unit test passed: they all run on `MemoryDB`, which stores objects in a
 * Map and has no `_id` at all.
 *
 * Behind it sat a second one the first was hiding — `fromDoc` derives `id` FROM `_id`, so a record
 * that did save would have come back with `id: "owner:mcp-server"`, and every lookup by type id
 * would have missed.
 *
 * Neither is about tree types. Both are about a composite key in a codebase whose mapper assumes
 * `_id` IS the id, so this tests the property rather than the field: what goes in comes out, and two
 * owners keep separate records under the same name.
 */

const URI = process.env.MONGO_URI || 'mongodb://admin:admin@localhost:27017/provisioning?authSource=admin';
let reachable = false;
let db: MongoDB;
let raw: MongoClient;
const OWNERS = ['roundtrip-owner-a', 'roundtrip-owner-b'];

beforeAll(async () => {
  try {
    raw = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 2000 });
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
    if (!reachable) return expect.unreachable('Mongo is not reachable; start it with scripts/ensure-mongo.sh');
    const seed = { ...TREE_TYPE_SEEDS[0]!, ownerId: OWNERS[0]! };
    await db.saveTreeType(seed);

    const back = await db.getTreeTypes(OWNERS[0]);
    expect(back).toHaveLength(1);
    expect(back[0]!.id).toBe(seed.id);
    expect(back[0]!.language).toBe(seed.language);
    expect(back[0]!.produces).toBe(seed.produces);
    expect(back[0]!.files.length).toBe(seed.files.length);
  }, 15_000);

  it('is idempotent, which is what seeding on every read depends on', async () => {
    // The route seeds on GET. If a second save threw, the list would be empty for the rest of time.
    if (!reachable) return;
    const seed = { ...TREE_TYPE_SEEDS[0]!, ownerId: OWNERS[0]! };
    await db.saveTreeType(seed);
    await db.saveTreeType({ ...seed, label: 'Edited' });
    const back = await db.getTreeTypes(OWNERS[0]);
    expect(back).toHaveLength(1);
    expect(back[0]!.label).toBe('Edited');
  }, 15_000);

  it('keeps two owners\' identically-named types apart', async () => {
    // The reason for a composite key at all.
    if (!reachable) return;
    await db.saveTreeType({ ...TREE_TYPE_SEEDS[0]!, ownerId: OWNERS[0]!, label: 'Mine' });
    await db.saveTreeType({ ...TREE_TYPE_SEEDS[0]!, ownerId: OWNERS[1]!, label: 'Theirs' });
    expect((await db.getTreeTypes(OWNERS[0]))[0]!.label).toBe('Mine');
    expect((await db.getTreeTypes(OWNERS[1]))[0]!.label).toBe('Theirs');
  }, 15_000);

  it('deletes only the owner it was asked about', async () => {
    if (!reachable) return;
    await db.saveTreeType({ ...TREE_TYPE_SEEDS[0]!, ownerId: OWNERS[0]! });
    await db.saveTreeType({ ...TREE_TYPE_SEEDS[0]!, ownerId: OWNERS[1]! });
    await db.deleteTreeType(TREE_TYPE_SEEDS[0]!.id, OWNERS[0]!);
    expect(await db.getTreeTypes(OWNERS[0])).toHaveLength(0);
    expect(await db.getTreeTypes(OWNERS[1])).toHaveLength(1);
  }, 15_000);
});

/**
 * The same trap, on the other collection that has it.
 *
 * `ModelThinkingProfile` is keyed on `modelId` and has no `id` at all, yet it went through
 * `toDoc`/`fromDoc` — which exist to map `id` ↔ `_id`. `toDoc` produced `_id: undefined` (harmless,
 * since the filter is stripped before the write) and `fromDoc` grafted Mongo's own ObjectId onto
 * the result as `id`, so every profile read back carried a field its type does not have.
 *
 * Benign only because nothing reads `.id` off a thinking profile. It is the identical shape to the
 * tree-type outage above, which was not benign, so it is tested rather than argued about.
 */
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
