import { emptiedEachTime } from '../../platform/lib/test-database.js';
import { releaseSettingsBehaviour } from '../testing/release-settings-behaviour.js';

const fresh = await emptiedEachTime();

releaseSettingsBehaviour(fresh);
