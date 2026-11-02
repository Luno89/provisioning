import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { buildTokenCleanupBehaviour } from '../testing/build-token-cleanup-behaviour.js';

buildTokenCleanupBehaviour(async () => memoryDatabase());
