import { emptiedEachTime } from '../platform/lib/test-database.js';
import { instancesStoreContract } from './testing/store-contract.js';

const fresh = await emptiedEachTime();

instancesStoreContract(async () => (await fresh()).instances);
