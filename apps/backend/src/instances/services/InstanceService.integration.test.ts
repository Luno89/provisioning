import { emptiedEachTime } from '../../platform/lib/test-database.js';
import { instanceServiceBehaviour } from '../testing/instance-service-behaviour.js';

instanceServiceBehaviour(await emptiedEachTime(), () => new Date());
