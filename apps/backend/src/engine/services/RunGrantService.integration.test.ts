import { testDatabase } from '../../platform/lib/test-database.js';
import { runGrantServiceBehaviour } from '../testing/run-grant-service-behaviour.js';

runGrantServiceBehaviour(() => testDatabase());
