import { emptiedEachTime } from '../../platform/lib/test-database.js';
import { modelServiceBehaviour } from '../testing/model-service-behaviour.js';

modelServiceBehaviour(await emptiedEachTime());
