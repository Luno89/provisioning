import { randomUUID } from 'node:crypto';
import { afterAll, inject } from 'vitest';
import { mongoHubStore } from '../lib/hub-mongo.js';
import type { HubStore } from '../lib/hub-store.js';
import { hubServiceBehaviour } from '../testing/hub-service-behaviour.js';

const opened: HubStore[] = [];
afterAll(async () => { for (const store of opened.splice(0)) await store.close(); });

hubServiceBehaviour(async () => {
  const store = mongoHubStore(inject('mongoUri'), `t_${randomUUID().replace(/-/g, '').slice(0, 20)}`);
  await store.init();
  opened.push(store);
  return store;
});
