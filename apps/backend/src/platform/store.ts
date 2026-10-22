import type { AreaStore } from './lib/collection.js';
import type { Db } from 'mongodb';
import type { MigrationRecord } from './lib/migrations.js';

export interface PlatformStore extends AreaStore {
  hasMigration(name: string): Promise<boolean>;
  recordMigration(record: MigrationRecord): Promise<void>;
}

export class MongoPlatformStore implements PlatformStore {
  constructor(private readonly db: () => Db) {}

  async ensureIndexes(): Promise<void> {}

  async hasMigration(name: string): Promise<boolean> {
    return Boolean(await this.db().collection('migrations').findOne({ _id: name as never }));
  }

  async recordMigration(record: MigrationRecord): Promise<void> {
    const { name, ...rest } = record;
    await this.db().collection('migrations').replaceOne({ _id: name as never }, rest, { upsert: true });
  }
}
