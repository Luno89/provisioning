import { emptiedEachTime } from '../platform/lib/test-database.js';
import { projectsStoreContract } from './testing/store-contract.js';

const fresh = await emptiedEachTime();

projectsStoreContract(async () => (await fresh()).projects);
