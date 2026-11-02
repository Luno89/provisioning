import { emptiedEachTime } from '../platform/lib/test-database.js';
import { engineStoreContract } from './testing/store-contract.js';

const fresh = await emptiedEachTime();

engineStoreContract(async () => (await fresh()).engine);
