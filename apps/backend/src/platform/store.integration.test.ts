import { emptiedEachTime } from './lib/test-database.js';
import { platformStoreContract } from './testing/store-contract.js';

const fresh = await emptiedEachTime();

platformStoreContract(async () => (await fresh()).platform);
