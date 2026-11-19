import { emptiedEachTime } from '../../platform/lib/test-database.js';
import { serverOrderBehaviour } from '../testing/server-order-behaviour.js';

serverOrderBehaviour(await emptiedEachTime());
