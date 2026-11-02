import { memoryStoreContract } from './testing/store-contract.js';
import { MemoryMemoryStore } from './testing/memory-store.js';

memoryStoreContract(async () => new MemoryMemoryStore());
