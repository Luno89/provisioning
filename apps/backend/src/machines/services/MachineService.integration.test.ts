import { emptiedEachTime } from '../../platform/lib/test-database.js';
import { machineServiceBehaviour } from '../testing/machine-service-behaviour.js';

const fresh = await emptiedEachTime();

machineServiceBehaviour(() => fresh());
