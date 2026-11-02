import { emptiedEachTime } from '../platform/lib/test-database.js';
import { memoryStoreContract } from './testing/store-contract.js';

const fresh = await emptiedEachTime();

memoryStoreContract(async () => (await fresh()).memory);
