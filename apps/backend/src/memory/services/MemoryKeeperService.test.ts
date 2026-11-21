import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { memoryKeeperBehaviour } from '../testing/memory-keeper-behaviour.js';

memoryKeeperBehaviour(async () => memoryDatabase());
