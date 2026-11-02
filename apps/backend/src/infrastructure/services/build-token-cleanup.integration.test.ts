import { emptiedEachTime } from '../../platform/lib/test-database.js';
import { buildTokenCleanupBehaviour } from '../testing/build-token-cleanup-behaviour.js';

buildTokenCleanupBehaviour(await emptiedEachTime());
