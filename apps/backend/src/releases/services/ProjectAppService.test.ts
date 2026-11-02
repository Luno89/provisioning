import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { projectAppBehaviour } from '../testing/project-app-behaviour.js';

projectAppBehaviour(async () => memoryDatabase());
