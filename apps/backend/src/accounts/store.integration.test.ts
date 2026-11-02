import { emptiedEachTime } from '../platform/lib/test-database.js';
import { accountsStoreContract } from './testing/store-contract.js';

const fresh = await emptiedEachTime();

accountsStoreContract(async () => (await fresh()).accounts);
