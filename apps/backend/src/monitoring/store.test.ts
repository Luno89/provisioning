import { MemoryMonitoringStore } from './testing/memory-store.js';
import { monitoringStoreContract } from './testing/store-contract.js';

monitoringStoreContract(async () => new MemoryMonitoringStore());
