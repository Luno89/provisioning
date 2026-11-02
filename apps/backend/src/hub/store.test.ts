import { hubStoreContract } from './testing/store-contract.js';
import { MemoryHubStore } from './testing/memory-store.js';

hubStoreContract(async () => new MemoryHubStore());
