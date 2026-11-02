import { emptiedEachTime } from '../platform/lib/test-database.js';
import { machinesStoreContract } from './testing/store-contract.js';

const fresh = await emptiedEachTime();

machinesStoreContract(async () => (await fresh()).machines);
