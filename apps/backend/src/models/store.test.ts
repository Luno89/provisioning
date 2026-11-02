import { modelsStoreContract } from './testing/store-contract.js';
import { MemoryModelsStore } from './testing/memory-store.js';

modelsStoreContract(async () => new MemoryModelsStore());
