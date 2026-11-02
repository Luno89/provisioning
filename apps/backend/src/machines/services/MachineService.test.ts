import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { machineServiceBehaviour } from '../testing/machine-service-behaviour.js';

machineServiceBehaviour(async () => memoryDatabase());
