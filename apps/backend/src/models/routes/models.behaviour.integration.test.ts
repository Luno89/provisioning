import { emptiedEachTime } from '../../platform/lib/test-database.js';
import { modelsRoutesBehaviour } from '../testing/models-routes-behaviour.js';

modelsRoutesBehaviour(await emptiedEachTime());
