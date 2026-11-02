import { emptiedEachTime } from '../platform/lib/test-database.js';
import { hubStoreContract } from './testing/store-contract.js';

const fresh = await emptiedEachTime();

hubStoreContract(async () => (await fresh()).hub);
