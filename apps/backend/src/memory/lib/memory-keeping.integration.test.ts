import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import { startCorpusStandIn, type CorpusStandIn } from '../../engine/testing/corpus-stand-in.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { corpusEndpointsWith } from '../../engine/lib/web-tools-resolver.js';
import type { DeploymentMetadata } from '../../platform/index.js';
import { consolidateOwner, keepEveryOwner } from './memory-keeping.js';
import { indexMemories } from './memory-index.js';
import { MEMORY_COLLECTION, MEMORY_INDEX } from './memory-rank.js';
import type { MemoryItem } from './memory-store.js';

const NOW = new Date().toISOString();
const daysBefore = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();

const memory = (id: string, category: MemoryItem['category'], title: string, days: number): MemoryItem => ({
  id, ownerId: 'keeper-owner', category, scope: 'global', status: 'active', title, text: `${title}, as the person said.`,
  createdAt: daysBefore(days), updatedAt: daysBefore(days),
});

let standIn: CorpusStandIn;
let db: MongoDB;

beforeAll(async () => {
  standIn = await startCorpusStandIn();
  db = await testDatabase();
});

afterAll(async () => {
  await standIn.stop();
});

describe('consolidating a person\'s memories in Mongo with their own Quickwit, Qdrant and TEI', () => {
  it('retires the older of two with the same title in Mongo and both indexes, and keeps the rest searchable', async () => {
    const older = memory('keep-a', 'environment_facts', 'DNS lives at Cloudflare', 8);
    const newer = memory('keep-b', 'environment_facts', 'DNS lives at Cloudflare', 6);
    const other = memory('keep-c', 'prompt_guidance', 'Answer in short sentences', 4);
    for (const item of [older, newer, other]) await db.memory.saveMemory(item);
    await indexMemories(standIn.endpoints, [older, newer, other]);

    const report = await consolidateOwner({ db, reach: async () => standIn.endpoints, now: () => NOW }, 'keeper-owner');

    expect(report).toMatchObject({ deduped: 1, live: 2, indexed: 2 });
    expect((await db.memory.getMemories('keeper-owner')).map((item) => [item.id, item.invalidAt ? `retired for ${item.supersededBy}` : 'current']).sort())
      .toEqual([['keep-a', 'retired for keep-b'], ['keep-b', 'current'], ['keep-c', 'current']]);
    expect(standIn.documents(MEMORY_INDEX).map((doc) => doc.memory_id)).not.toContain('keep-a');
    expect(standIn.points(MEMORY_COLLECTION).map((point) => point.memory_id).sort()).toEqual(['keep-b', 'keep-c']);
  });

  it('keeps what a finished task established as a lesson in Mongo, once', async () => {
    const findings = 'The shop\'s Odoo needs the website module installed before any theme can be applied, and installing it afterwards resets the theme to the default one, so the module goes in first and the theme second on every new database.';
    await db.projects.saveLeaf({ id: 'leaf-theme', ownerId: 'keeper-lessons', branchId: 'b1', title: 'Apply the shop theme', status: 'succeeded', findings } as never);

    await consolidateOwner({ db, reach: async () => ({}), now: () => NOW }, 'keeper-lessons');
    await consolidateOwner({ db, reach: async () => ({}), now: () => NOW }, 'keeper-lessons');

    const lessons = (await db.memory.getMemories('keeper-lessons')).filter((item) => !item.invalidAt);
    expect(lessons.map((item) => [item.title, item.category, item.provenance?.taskId])).toEqual([['What "Apply the shop theme" established', 'lessons_learned', 'leaf-theme']]);
  });
});

describe('consolidating everyone\'s memories in Mongo, each person on their own', () => {
  const deployed = (appType: string, ownerId: string, clusterId: string, over: Partial<DeploymentMetadata> = {}): DeploymentMetadata => ({
    id: `${appType}-${ownerId}`, name: `${appType}-${ownerId}`, appType, status: 'running', clusterId, strategy: 'helm', ownerId, ...over,
  });
  const owned = (id: string, ownerId: string, title: string, days: number): MemoryItem => ({ ...memory(id, 'environment_facts', title, days), ownerId });

  it('consolidates the next person when one person\'s indexes cannot be reached, and keeps why for that person', async () => {
    for (const ownerId of ['keeping-ann', 'keeping-bob']) {
      const clusterId = `${ownerId}-desk`;
      for (const appType of ['quickwit', 'tei']) await db.infrastructure.saveDeployment(deployed(appType, ownerId, clusterId));
      await db.infrastructure.saveDeployment(deployed('qdrant', ownerId, clusterId, { qdrantApiKey: 'stand-in-key' }));
    }
    for (const item of [owned('ann-a', 'keeping-ann', 'Backups run at two', 8), owned('ann-b', 'keeping-ann', 'Backups run at two', 6)]) await db.memory.saveMemory(item);
    const bobs = [owned('bob-a', 'keeping-bob', 'The shop sells tea', 8), owned('bob-b', 'keeping-bob', 'The shop sells tea', 6)];
    for (const item of bobs) await db.memory.saveMemory(item);
    await indexMemories(standIn.endpoints, bobs);
    const reach = (ownerId: string) => corpusEndpointsWith({
      db: db.infrastructure,
      serviceUrl: async (clusterId) => {
        if (clusterId === 'keeping-ann-desk') throw new Error('the cluster proxy could not reach keeping-ann-desk');
        return standIn.base;
      },
    }, ownerId);

    const outcomes = await keepEveryOwner({ db, reach, now: () => NOW });

    const ours = outcomes.filter((outcome) => outcome.state.ownerId.startsWith('keeping-'));
    expect(ours.map((outcome) => [outcome.state.ownerId, outcome.state.state]).sort()).toEqual([['keeping-ann', 'down'], ['keeping-bob', 'kept']]);
    expect((await db.memory.getMemories('keeping-bob')).map((item) => [item.id, item.invalidAt ? `retired for ${item.supersededBy}` : 'current']).sort())
      .toEqual([['bob-a', 'retired for bob-b'], ['bob-b', 'current']]);
    expect(standIn.points(MEMORY_COLLECTION).map((point) => point.memory_id)).not.toContain('bob-a');
    expect((await db.memory.getMemories('keeping-ann')).filter((item) => !item.invalidAt).map((item) => item.id).sort()).toEqual(['ann-a', 'ann-b']);
    expect(await db.memory.getKeepingState('keeping-ann')).toEqual({
      ownerId: 'keeping-ann', state: 'down', since: NOW, at: NOW,
      reason: expect.stringMatching(/^(Quickwit|Qdrant|TEI) "\w+-keeping-ann" is deployed but not answering: the cluster proxy could not reach keeping-ann-desk$/),
    });
    expect(await db.memory.getKeepingState('keeping-bob')).toEqual({ ownerId: 'keeping-bob', state: 'kept', at: NOW });
  });
});
