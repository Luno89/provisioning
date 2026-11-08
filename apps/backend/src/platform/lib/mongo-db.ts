import type { Tx } from './transaction.js';
import { MongoPlatformStore } from '../store.js';
import { MongoAccountsStore } from '../../accounts/store.js';
import { MongoInstancesStore } from '../../instances/store.js';
import { MongoHubStore } from '../../hub/store.js';
import { markingHubWrites } from '../../hub/lib/hub-sync.js';
import { MongoProjectsStore } from '../../projects/store.js';
import { MongoReleasesStore } from '../../releases/store.js';
import { MongoFilesStore } from '../../files/store.js';
import { MongoMachinesStore } from '../../machines/store.js';
import { MongoMonitoringStore } from '../../monitoring/store.js';
import { MongoModelsStore } from '../../models/store.js';
import { MongoMemoryStore } from '../../memory/store.js';
import { MongoChecksStore } from '../../checks/store.js';
import { MongoInfrastructureStore } from '../../infrastructure/store.js';
import { MongoEngineStore } from '../../engine/store.js';
import { MongoClient, type Db } from 'mongodb';
import type { Database } from './db-interface.js';
import type { MongoTarget } from './mongo-target.js';
import type { SecretKey } from './crypto.js';
import { clientOptionsFor } from './collection.js';
import { ensureReplicaSet } from './replica-set.js';

export { databaseOf, mongoTarget } from './mongo-target.js';

export interface DatabaseSettings {
  mongo: MongoTarget;
  dataKey: SecretKey;
}

export class MongoDB implements Database {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  readonly platform: MongoPlatformStore;
  readonly accounts: MongoAccountsStore;
  readonly instances: MongoInstancesStore;
  readonly hub: MongoHubStore;
  readonly projects: MongoProjectsStore;
  readonly releases: MongoReleasesStore;
  readonly files: MongoFilesStore;
  readonly machines: MongoMachinesStore;
  readonly monitoring: MongoMonitoringStore;
  readonly models: MongoModelsStore;
  readonly memory: MongoMemoryStore;
  readonly checks: MongoChecksStore;
  readonly infrastructure: MongoInfrastructureStore;
  readonly engine: MongoEngineStore;

  constructor(private readonly settings: DatabaseSettings) {
    this.platform = new MongoPlatformStore(() => this.db!);
    this.accounts = new MongoAccountsStore(() => this.db!);
    this.instances = new MongoInstancesStore(() => this.db!);
    this.hub = new MongoHubStore(() => this.db!);
    this.projects = markingHubWrites(new MongoProjectsStore(() => this.db!), this.hub);
    this.releases = new MongoReleasesStore(() => this.db!);
    this.files = new MongoFilesStore(() => this.db!, this.settings.dataKey);
    this.machines = new MongoMachinesStore(() => this.db!);
    this.monitoring = new MongoMonitoringStore(() => this.db!);
    this.models = new MongoModelsStore(() => this.db!);
    this.memory = new MongoMemoryStore(() => this.db!);
    this.checks = new MongoChecksStore(() => this.db!);
    this.infrastructure = new MongoInfrastructureStore(() => this.db!, this.settings.dataKey);
    this.engine = markingHubWrites(new MongoEngineStore(() => this.db!), this.hub);
  }

  async init(): Promise<void> {
    const { uri, dbName, e2e: isE2E } = this.settings.mongo;

    this.client = new MongoClient(uri, clientOptionsFor(uri));
    await this.client.connect();
    await ensureReplicaSet(this.client);
    this.db = this.client.db(dbName);

    if (isE2E) {
      await this.db.dropDatabase();
    }

    await this.platform.ensureIndexes();
    await this.accounts.ensureIndexes();
    await this.instances.ensureIndexes();
    await this.hub.ensureIndexes();
    await this.projects.ensureIndexes();
    await this.releases.ensureIndexes();
    await this.files.ensureIndexes();
    await this.machines.ensureIndexes();
    await this.monitoring.ensureIndexes();
    await this.models.ensureIndexes();
    await this.memory.ensureIndexes();
    await this.checks.ensureIndexes();
    await this.infrastructure.ensureIndexes();
    await this.engine.ensureIndexes();
  }

  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    if (!this.client) throw new Error('the database is not connected');
    return this.client.withSession((session) => session.withTransaction(() => work({ session })));
  }

  async dropDatabase(): Promise<void> {
    await this.db?.dropDatabase();
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
    }
  }
}
