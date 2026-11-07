import { MemoryObjectStore } from '../testing/memory-object-store.js';
import { objectStoreContract } from '../testing/object-store-contract.js';

objectStoreContract(async () => new MemoryObjectStore());
