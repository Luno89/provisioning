import { emptiedEachTime } from '../../platform/lib/test-database.js';
import { machineMirrorBehaviour } from '../testing/machine-mirror-behaviour.js';

const fresh = await emptiedEachTime();

machineMirrorBehaviour(() => fresh());
