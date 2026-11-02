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
import { MemoryPlatformStore } from './memory-store.js';

export function memoryDatabase(): Database {
  const hub = new MemoryHubStore();
  return {
    init: async () => undefined,
    close: async () => undefined,
    platform: new MemoryPlatformStore(),
    accounts: new MemoryAccountsStore(),
    instances: new MemoryInstancesStore(),
    hub,
    projects: markingHubWrites(new MemoryProjectsStore(), hub),
    releases: new MemoryReleasesStore(),
    files: new MemoryFilesStore(),
    machines: new MemoryMachinesStore(),
    monitoring: new MemoryMonitoringStore(),
    models: new MemoryModelsStore(),
    memory: new MemoryMemoryStore(),
    checks: new MemoryChecksStore(),
    infrastructure: new MemoryInfrastructureStore(),
    engine: markingHubWrites(new MemoryEngineStore(), hub),
  };
}
