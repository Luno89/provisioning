import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { serverOrderBehaviour } from '../testing/server-order-behaviour.js';

serverOrderBehaviour(async () => memoryDatabase());
