import { emptiedEachTime, freshDb } from '../platform/lib/test-database.js';
import { MongoProjectsStore } from './store.js';
import { projectGroupContract, projectsStoreContract } from './testing/store-contract.js';

const fresh = await emptiedEachTime();

projectsStoreContract(async () => (await fresh()).projects);

projectGroupContract(async () => {
  const db = await freshDb();
  return { store: new MongoProjectsStore(() => db), leftover: async (projectId, group) => { await db.collection<{ _id: string; ownerId: string; group: string }>('hubLinks').insertOne({ _id: projectId, ownerId: 'owner-1', group }); } };
});
