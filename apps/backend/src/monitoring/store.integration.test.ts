import { emptiedEachTime } from '../platform/lib/test-database.js';
import { monitoringStoreContract } from './testing/store-contract.js';

const fresh = await emptiedEachTime();

monitoringStoreContract(async () => (await fresh()).monitoring);
