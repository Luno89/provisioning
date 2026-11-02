import { emptiedEachTime } from '../../platform/lib/test-database.js';
import { treeTypeDescriptionsBehaviour } from '../testing/tree-type-descriptions-behaviour.js';

const fresh = await emptiedEachTime();

treeTypeDescriptionsBehaviour(() => fresh());
