import { emptiedEachTime } from '../../platform/lib/test-database.js';
import { imageReleasesBehaviour } from '../testing/image-releases-behaviour.js';

const fresh = await emptiedEachTime();

imageReleasesBehaviour(fresh);
