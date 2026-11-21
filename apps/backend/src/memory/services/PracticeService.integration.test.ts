import { emptiedEachTime } from '../../platform/lib/test-database.js';
import { standInIndexing } from '../testing/memory-index.js';
import { practiceBehaviour } from '../testing/practice-behaviour.js';

const indexing = await standInIndexing();
const fresh = await emptiedEachTime();

practiceBehaviour(async () => ({ store: (await fresh()).memory, indexing }));
