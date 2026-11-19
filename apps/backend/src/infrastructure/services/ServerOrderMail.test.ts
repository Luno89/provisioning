import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { serverOrderMailBehaviour } from '../testing/server-order-mail-behaviour.js';

serverOrderMailBehaviour(async () => memoryDatabase());
