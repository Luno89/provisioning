import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { modelsRoutesBehaviour } from '../testing/models-routes-behaviour.js';

modelsRoutesBehaviour(async () => memoryDatabase());
