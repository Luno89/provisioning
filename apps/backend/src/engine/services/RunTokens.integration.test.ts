import { testDatabase } from '../../platform/lib/test-database.js';
import { runTokensBehaviour } from '../testing/run-tokens-behaviour.js';

runTokensBehaviour(() => testDatabase());
