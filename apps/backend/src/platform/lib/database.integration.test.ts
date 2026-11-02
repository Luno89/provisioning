import { databaseContract } from '../testing/database-contract.js';
import { emptiedEachTime } from './test-database.js';

const fresh = await emptiedEachTime();

databaseContract(fresh);
