import { collectionIn, type Collections } from '../platform/testing/memory-records.js';
import { MemoryProjectsStore } from './testing/memory-store.js';
import { projectGroupContract, projectsStoreContract } from './testing/store-contract.js';

projectsStoreContract(async () => new MemoryProjectsStore());

projectGroupContract(async () => {
  const collections: Collections = new Map();
  return { store: new MemoryProjectsStore(collections), leftover: async (projectId, group) => { collectionIn(collections, 'hubLinks').set(projectId, { ownerId: 'owner-1', group }); } };
});
