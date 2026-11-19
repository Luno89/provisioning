import { emptiedEachTime } from '../../platform/lib/test-database.js';
import { serverOrderMailBehaviour } from '../testing/server-order-mail-behaviour.js';

serverOrderMailBehaviour(await emptiedEachTime());
