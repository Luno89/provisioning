import { emptiedEachTime } from '../../platform/lib/test-database.js';
import { extensionServiceBehaviour } from '../testing/extension-service-behaviour.js';

extensionServiceBehaviour(await emptiedEachTime());
