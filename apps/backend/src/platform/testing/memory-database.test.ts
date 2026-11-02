import { databaseContract } from './database-contract.js';
import { memoryDatabase } from './memory-database.js';

databaseContract(async () => memoryDatabase());
