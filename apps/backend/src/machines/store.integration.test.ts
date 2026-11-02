import { testDatabase } from '../platform/lib/test-database.js';
import { machinesStoreContract } from './testing/store-contract.js';

machinesStoreContract(async () => (await testDatabase()).machines);
