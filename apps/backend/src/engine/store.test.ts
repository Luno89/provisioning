import { engineStoreContract } from './testing/store-contract.js';
import { MemoryEngineStore } from './testing/memory-store.js';

engineStoreContract(async () => new MemoryEngineStore());
