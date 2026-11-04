import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { machineAccountsBehaviour } from '../testing/machine-accounts-behaviour.js';

machineAccountsBehaviour(async () => memoryDatabase());
