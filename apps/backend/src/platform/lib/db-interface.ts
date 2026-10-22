import { MongoDB } from './mongo-db.js';
import { mongoPayloadBlobs } from './mongo-payload-blobs.js';
import { inMemoryPayloadBlobs, type PayloadBlobs } from './payload-storage.js';
import type { PlatformStore } from '../store.js';
import type { AccountsStore } from '../../accounts/store.js';
import type { InstancesStore } from '../../instances/store.js';
import type { HubStore } from '../../hub/store.js';
import type { ProjectsStore } from '../../projects/index.js';
import type { ReleasesStore } from '../../releases/store.js';
import type { FilesStore } from '../../files/store.js';
import type { MachinesStore } from '../../machines/store.js';
import type { MonitoringStore } from '../../monitoring/store.js';
import type { ModelsStore } from '../../models/store.js';
import type { MemoryStore } from '../../memory/store.js';
import type { ChecksStore } from '../../checks/store.js';
import type { InfrastructureStore } from '../../infrastructure/index.js';
import type { EngineStore } from '../../engine/index.js';

export interface Database {
  init(): Promise<void>;
  close(): Promise<void>;
  platform: PlatformStore;
  accounts: AccountsStore;
  instances: InstancesStore;
  hub: HubStore;
  projects: ProjectsStore;
  releases: ReleasesStore;
  files: FilesStore;
  machines: MachinesStore;
  monitoring: MonitoringStore;
  models: ModelsStore;
  memory: MemoryStore;
  checks: ChecksStore;
  infrastructure: InfrastructureStore;
  engine: EngineStore;
}

let payloadBlobs: PayloadBlobs | undefined;

export function sharedPayloadBlobs(): PayloadBlobs {
  if (!payloadBlobs) {
    const inMemory = process.env.NODE_ENV === 'test' && !process.env.IS_E2E;
    payloadBlobs = inMemory ? inMemoryPayloadBlobs() : mongoPayloadBlobs();
  }
  return payloadBlobs;
}

export function createDatabase(env: Readonly<Record<string, string | undefined>> = process.env): Database {
  return new MongoDB(env);
}