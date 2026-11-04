import { emptiedEachTime } from '../../platform/lib/test-database.js';
import { machineAccountsBehaviour } from '../testing/machine-accounts-behaviour.js';

const fresh = await emptiedEachTime();

machineAccountsBehaviour(() => fresh());
