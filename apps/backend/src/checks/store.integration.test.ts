import { emptiedEachTime } from '../platform/lib/test-database.js';
import { checksStoreContract } from './testing/store-contract.js';

const fresh = await emptiedEachTime();

checksStoreContract(async () => (await fresh()).checks);
