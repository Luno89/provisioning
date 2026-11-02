import { infrastructureStoreContract } from './testing/store-contract.js';
import { MemoryInfrastructureStore } from './testing/memory-store.js';

infrastructureStoreContract(async () => new MemoryInfrastructureStore());
