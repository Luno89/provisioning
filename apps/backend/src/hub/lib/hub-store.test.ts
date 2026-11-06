import { sharedProjectsContract } from '../testing/hub-store-contract.js';
import { memoryHubStore } from '../testing/memory-hub-store.js';

sharedProjectsContract(async () => memoryHubStore());
