import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { runTokensBehaviour } from '../testing/run-tokens-behaviour.js';

runTokensBehaviour(async () => memoryDatabase());
