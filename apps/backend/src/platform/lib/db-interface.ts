import { MongoDB } from './mongo-db.js';
import { mongoPayloadBlobs } from './mongo-payload-blobs.js';
import { inMemoryPayloadBlobs, type PayloadBlobs } from './payload-storage.js';
import type { PlatformStore } from '../store.js';
import type { AccountsStore } from '../../accounts/index.js';
import type { InstancesStore } from '../../instances/index.js';
import type { HubStore } from '../../hub/index.js';
import type { ProjectsStore } from '../../projects/index.js';
import type { ReleasesStore } from '../../releases/index.js';
import type { FilesStore } from '../../files/index.js';
import type { MachinesStore } from '../../machines/index.js';
import type { MonitoringStore } from '../../monitoring/index.js';
import type { ModelsStore } from '../../models/index.js';
import type { MemoryStore } from '../../memory/index.js';
import type { ChecksStore } from '../../checks/index.js';
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