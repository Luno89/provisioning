import { emptiedEachTime } from '../../platform/lib/test-database.js';
import { memoryKeeperBehaviour } from '../testing/memory-keeper-behaviour.js';

const fresh = await emptiedEachTime();

memoryKeeperBehaviour(() => fresh());
