import { MemoryProjectsStore } from './testing/memory-store.js';
import { projectsStoreContract } from './testing/store-contract.js';

projectsStoreContract(async () => new MemoryProjectsStore());
