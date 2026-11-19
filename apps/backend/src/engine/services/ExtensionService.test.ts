import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { extensionServiceBehaviour } from '../testing/extension-service-behaviour.js';

extensionServiceBehaviour(async () => memoryDatabase());
