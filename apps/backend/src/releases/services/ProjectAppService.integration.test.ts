import { emptiedEachTime } from '../../platform/lib/test-database.js';
import { projectAppBehaviour } from '../testing/project-app-behaviour.js';

const fresh = await emptiedEachTime();

projectAppBehaviour(fresh);
