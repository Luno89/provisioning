import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { treeTypeDescriptionsBehaviour } from '../testing/tree-type-descriptions-behaviour.js';

treeTypeDescriptionsBehaviour(async () => memoryDatabase());
