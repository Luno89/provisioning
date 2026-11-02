import { instancesStoreContract } from './testing/store-contract.js';
import { MemoryInstancesStore } from './testing/memory-store.js';

instancesStoreContract(async () => new MemoryInstancesStore());
