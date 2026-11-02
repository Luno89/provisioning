import { emptiedEachTime } from '../platform/lib/test-database.js';
import { modelsStoreContract } from './testing/store-contract.js';

const fresh = await emptiedEachTime();

modelsStoreContract(async () => (await fresh()).models);
