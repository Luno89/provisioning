import { emptiedEachTime } from '../../platform/lib/test-database.js';
import { storyDropBehaviour } from '../testing/story-drop-behaviour.js';

const fresh = await emptiedEachTime();

storyDropBehaviour(fresh);
