import { emptiedEachTime } from '../platform/lib/test-database.js';
import { releasesStoreContract } from './testing/store-contract.js';

const fresh = await emptiedEachTime();

releasesStoreContract(async () => (await fresh()).releases);
