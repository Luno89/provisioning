import { emptiedEachTime } from '../../platform/lib/test-database.js';
import { machineClustersBehaviour } from '../testing/machine-clusters-behaviour.js';

const fresh = await emptiedEachTime();

machineClustersBehaviour(() => fresh());
