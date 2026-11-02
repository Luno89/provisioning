import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { customizationsBehaviour } from '../testing/customizations-behaviour.js';

customizationsBehaviour(async () => memoryDatabase());
