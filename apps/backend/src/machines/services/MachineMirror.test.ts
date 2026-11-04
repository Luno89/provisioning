import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { machineMirrorBehaviour } from '../testing/machine-mirror-behaviour.js';

machineMirrorBehaviour(async () => memoryDatabase());
