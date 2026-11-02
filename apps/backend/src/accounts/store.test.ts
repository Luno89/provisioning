import { accountsStoreContract } from './testing/store-contract.js';
import { MemoryAccountsStore } from './testing/memory-store.js';

accountsStoreContract(async () => new MemoryAccountsStore());
