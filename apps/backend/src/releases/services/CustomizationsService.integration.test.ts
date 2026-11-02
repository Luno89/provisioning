import { emptiedEachTime } from '../../platform/lib/test-database.js';
import { customizationsBehaviour } from '../testing/customizations-behaviour.js';

const fresh = await emptiedEachTime();

customizationsBehaviour(fresh);
