import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { egressBehaviour } from '../testing/egress-behaviour.js';

egressBehaviour(async () => memoryDatabase());
