import { machinesStoreContract } from './testing/store-contract.js';
import { MemoryMachinesStore } from './testing/memory-store.js';

machinesStoreContract(async () => new MemoryMachinesStore());
