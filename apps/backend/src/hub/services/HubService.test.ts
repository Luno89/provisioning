import { memoryHubStore } from '../lib/hub-store.js';
import { hubServiceBehaviour } from '../testing/hub-service-behaviour.js';

hubServiceBehaviour(async () => memoryHubStore());
