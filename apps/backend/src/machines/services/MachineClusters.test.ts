import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { machineClustersBehaviour } from '../testing/machine-clusters-behaviour.js';

machineClustersBehaviour(async () => memoryDatabase());
