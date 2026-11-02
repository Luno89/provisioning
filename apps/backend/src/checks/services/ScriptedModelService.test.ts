import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { scriptedModelBehaviour } from '../testing/scripted-model-behaviour.js';

scriptedModelBehaviour(async () => memoryDatabase());
