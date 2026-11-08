import type { Tx } from './transaction.js';
import { MongoDB, type DatabaseSettings } from './mongo-db.js';
import { mongoPayloadBlobs } from './mongo-payload-blobs.js';
import type { PayloadBlobs } from './payload-storage.js';
import type { MongoTarget } from './mongo-target.js';
import type { PlatformStore } from '../store.js';
import type { DependencyReporter } from './dependencies.js';
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
  ping(): Promise<void>;
  reportReachTo(reporter: DependencyReporter): void;
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
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
let payloadMongo: MongoTarget | undefined;

export function keepPayloadsIn(mongo: MongoTarget): void {
  payloadMongo = mongo;
}

export function sharedPayloadBlobs(): PayloadBlobs {
  if (!payloadMongo) throw new Error('this process was not told where Temporal\'s large payloads are kept: its entry point calls keepPayloadsIn with its settings first');
  payloadBlobs ??= mongoPayloadBlobs(payloadMongo);
  return payloadBlobs;
}

export function createDatabase(settings: DatabaseSettings): Database {
  return new MongoDB(settings);
}