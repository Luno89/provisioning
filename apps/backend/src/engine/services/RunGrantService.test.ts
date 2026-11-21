import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { runGrantServiceBehaviour } from '../testing/run-grant-service-behaviour.js';

runGrantServiceBehaviour(async () => memoryDatabase());
