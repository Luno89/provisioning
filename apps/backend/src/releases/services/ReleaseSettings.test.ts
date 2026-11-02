import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { releaseSettingsBehaviour } from '../testing/release-settings-behaviour.js';

releaseSettingsBehaviour(async () => memoryDatabase());
