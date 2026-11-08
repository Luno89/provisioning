import { MemoryAccountsStore } from '../../accounts/testing/memory-store.js';
import { MemoryChecksStore } from '../../checks/testing/memory-store.js';
import { MemoryEngineStore } from '../../engine/testing/memory-store.js';
import { MemoryFilesStore } from '../../files/testing/memory-store.js';
import { markingHubWrites } from '../../hub/lib/hub-sync.js';
import { MemoryHubStore } from '../../hub/testing/memory-store.js';
import { MemoryInfrastructureStore } from '../../infrastructure/testing/memory-store.js';
import { MemoryInstancesStore } from '../../instances/testing/memory-store.js';
import { MemoryMachinesStore } from '../../machines/testing/memory-store.js';
import { MemoryMemoryStore } from '../../memory/testing/memory-store.js';
import { MemoryModelsStore } from '../../models/testing/memory-store.js';
import { MemoryMonitoringStore } from '../../monitoring/testing/memory-store.js';
import { MemoryProjectsStore } from '../../projects/testing/memory-store.js';
import { MemoryReleasesStore } from '../../releases/testing/memory-store.js';
import type { Database } from '../lib/db-interface.js';
import type { Collections } from './memory-records.js';
import { MemoryPlatformStore } from './memory-store.js';

export function memoryDatabase(): Database {
  const shared: Collections = new Map();
  const hub = new MemoryHubStore(shared);
  return {
    init: async () => undefined,
    close: async () => undefined,
    ping: async () => undefined,
    reportReachTo: () => undefined,
    async transaction(work) {
      const before = new Map([...shared].map(([name, rows]) => [name, new Map([...rows].map(([key, row]) => [key, structuredClone(row)]))]));
      try {
        return await work({});
      } catch (failure) {
        for (const [name, rows] of shared) {
          rows.clear();
          for (const [key, row] of before.get(name) ?? []) rows.set(key, row);
        }
        throw failure;
      }
    },
    platform: new MemoryPlatformStore(),
    accounts: new MemoryAccountsStore(shared),
    instances: new MemoryInstancesStore(shared),
    hub,
    projects: markingHubWrites(new MemoryProjectsStore(shared), hub),
    releases: new MemoryReleasesStore(shared),
    files: new MemoryFilesStore(shared),
    machines: new MemoryMachinesStore(shared),
    monitoring: new MemoryMonitoringStore(shared),
    models: new MemoryModelsStore(shared),
    memory: new MemoryMemoryStore(shared),
    checks: new MemoryChecksStore(shared),
    infrastructure: new MemoryInfrastructureStore(undefined, shared),
    engine: markingHubWrites(new MemoryEngineStore(shared), hub),
  };
}
