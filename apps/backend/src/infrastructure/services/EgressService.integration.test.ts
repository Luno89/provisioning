import { emptiedEachTime } from '../../platform/lib/test-database.js';
import { egressBehaviour } from '../testing/egress-behaviour.js';

egressBehaviour(await emptiedEachTime());
