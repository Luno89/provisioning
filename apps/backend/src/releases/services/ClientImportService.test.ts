import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { clientImportBehaviour } from '../testing/client-import-behaviour.js';

clientImportBehaviour(async () => memoryDatabase());
