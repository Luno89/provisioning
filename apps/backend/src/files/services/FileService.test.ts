import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { fileServiceBehaviour } from '../testing/file-service-behaviour.js';

fileServiceBehaviour(async () => memoryDatabase());
