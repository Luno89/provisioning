import { memoryHubStore } from '../testing/memory-hub-store.js';
import { hubServiceBehaviour } from '../testing/hub-service-behaviour.js';

hubServiceBehaviour(async () => memoryHubStore());
