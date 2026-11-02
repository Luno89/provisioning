import { releasesStoreContract } from './testing/store-contract.js';
import { MemoryReleasesStore } from './testing/memory-store.js';

releasesStoreContract(async () => new MemoryReleasesStore());
