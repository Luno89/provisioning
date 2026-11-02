import { emptiedEachTime } from '../../platform/lib/test-database.js';
import { accessBehaviour } from '../testing/access-behaviour.js';

accessBehaviour(await emptiedEachTime());
