import { movedSettingsFrom } from '../lib/instance-move.js';
import { describe, expect, it } from 'vitest';
import { mongoClientFor } from '../../platform/lib/collection.js';
import { testDatabaseAt } from '../../platform/lib/test-database.js';
import { MoveExport } from './MoveExport.js';
import { restoreMongo } from './mongo-restore.js';

describe('moving an instance\'s Mongo', () => {
  it('exports every record of one database and restores them into another, the way a move carries them', async () => {
    const { db: from, uri: fromUri, dbName: fromName } = await testDatabaseAt();
    const { db: into, uri: intoUri, dbName: intoName } = await testDatabaseAt();
    await from.projects.saveProject({ id: 'p1', name: 'Shop', ownerId: 'bo', createdAt: 't' } as never);
    await from.infrastructure.saveDeployment({ id: 'd1', name: 'shop', clusterId: 'c1', strategy: 'helm', status: 'running', ownerId: 'bo' } as never);
    const exporter = new MoveExport({ instanceId: 'i1', ownerId: 'bo', trusted: new Map(), dataDir: '/nowhere', mongo: { uri: fromUri, dbName: fromName }, moved: movedSettingsFrom({}), running: async () => [], claim: async () => true, cluster: { kubectl: async () => { throw new Error('a Mongo export asks no cluster'); }, read: async () => { throw new Error('a Mongo export asks no cluster'); } } });
    const part = exporter.open('mongo');
    const client = mongoClientFor(intoUri);
    await client.connect();
    const restored = await restoreMongo(client, intoName, part.out).finally(() => client.close());
    await part.done;
    expect(restored).toBeGreaterThanOrEqual(2);
    expect((await into.projects.getProjects()).map((project) => project.id)).toEqual(['p1']);
    expect((await into.infrastructure.getDeployments()).map((dep) => dep.id)).toEqual(['d1']);
  });
});
