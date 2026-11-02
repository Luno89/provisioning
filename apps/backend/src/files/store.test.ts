import { MemoryFilesStore } from './testing/memory-store.js';
import { filesStoreContract } from './testing/store-contract.js';

filesStoreContract(async () => new MemoryFilesStore());
