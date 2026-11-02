import { sharedProjectsContract } from '../testing/hub-store-contract.js';
import { memoryHubStore } from './hub-store.js';

sharedProjectsContract(async () => memoryHubStore());
