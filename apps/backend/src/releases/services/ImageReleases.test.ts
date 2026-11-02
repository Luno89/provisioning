import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { imageReleasesBehaviour } from '../testing/image-releases-behaviour.js';

imageReleasesBehaviour(async () => memoryDatabase());
