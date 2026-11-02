import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { accessBehaviour } from '../testing/access-behaviour.js';

accessBehaviour(async () => memoryDatabase());
