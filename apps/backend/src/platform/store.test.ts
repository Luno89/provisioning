import { platformStoreContract } from './testing/store-contract.js';
import { MemoryPlatformStore } from './testing/memory-store.js';

platformStoreContract(async () => new MemoryPlatformStore());
