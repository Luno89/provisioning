import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { storyDropBehaviour } from '../testing/story-drop-behaviour.js';

storyDropBehaviour(async () => memoryDatabase());
