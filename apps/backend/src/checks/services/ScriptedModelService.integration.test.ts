import { emptiedEachTime } from '../../platform/lib/test-database.js';
import { scriptedModelBehaviour } from '../testing/scripted-model-behaviour.js';

scriptedModelBehaviour(await emptiedEachTime());
