import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { modelServiceBehaviour } from '../testing/model-service-behaviour.js';

modelServiceBehaviour(async () => memoryDatabase());
