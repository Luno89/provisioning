import { MemoryChecksStore } from './testing/memory-store.js';
import { checksStoreContract } from './testing/store-contract.js';

checksStoreContract(async () => new MemoryChecksStore());
