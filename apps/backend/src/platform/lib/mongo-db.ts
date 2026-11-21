import type { Tx } from './transaction.js';
import { MongoPlatformStore } from '../store.js';
import { MongoAccountsStore } from '../../accounts/store.js';
import { MongoInstancesStore } from '../../instances/store.js';
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
import type { Db } from 'mongodb';
import type { Database } from './db-interface.js';
import type { MongoTarget } from './mongo-target.js';
import type { SecretKey } from './crypto.js';
import { leaseMongo, type MongoLease } from './mongo-lease.js';
import type { DependencyReporter } from './dependencies.js';
import { fencedDb } from './fenced-db.js';
import { theFence } from './fence.js';

export { databaseOf, mongoTarget } from './mongo-target.js';

export interface DatabaseSettings {
  mongo: MongoTarget;
  dataKey: SecretKey;
}

export class MongoDB implements Database {
  private lease: MongoLease | null = null;
  private db: Db | null = null;
  private readonly reporters: DependencyReporter[] = [];
  readonly platform: MongoPlatformStore;
  readonly accounts: MongoAccountsStore;
  readonly instances: MongoInstancesStore;
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
    this.projects = new MongoProjectsStore(() => this.db!);
    this.releases = new MongoReleasesStore(() => this.db!);
    this.files = new MongoFilesStore(() => this.db!, this.settings.dataKey);
    this.machines = new MongoMachinesStore(() => this.db!);
    this.monitoring = new MongoMonitoringStore(() => this.db!);
    this.models = new MongoModelsStore(() => this.db!);
    this.memory = new MongoMemoryStore(() => this.db!);
    this.checks = new MongoChecksStore(() => this.db!);
    this.infrastructure = new MongoInfrastructureStore(() => this.db!, this.settings.dataKey);
    this.engine = new MongoEngineStore(() => this.db!);
  }

  async init(): Promise<void> {
    const { uri, dbName } = this.settings.mongo;

    this.lease = await leaseMongo(uri, this.reporters);
    this.db = fencedDb(this.lease.client.db(dbName), theFence());

    await this.platform.ensureIndexes();
    await this.accounts.ensureIndexes();
    await this.instances.ensureIndexes();
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

  async ping(): Promise<void> {
    if (!this.db) throw new Error('the database is not connected');
    await this.db.command({ ping: 1 });
  }

  reportReachTo(reporter: DependencyReporter): void {
    if (this.lease) throw new Error('the database reports how Mongo answers only to those told before it connects');
    this.reporters.push(reporter);
  }

  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    if (!this.lease) throw new Error('the database is not connected');
    return this.lease.client.withSession((session) => session.withTransaction(() => work({ session })));
  }

  async dropDatabase(): Promise<void> {
    await this.db?.dropDatabase();
  }

  async close(): Promise<void> {
    if (this.lease) {
      await this.lease.release();
      this.lease = null;
      this.db = null;
    }
  }
}
