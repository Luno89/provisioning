export interface MigrationRecord {
  name: string;
  at: string;
  result: Record<string, number>;
}

export interface MigrationLedger {
  hasMigration(name: string): Promise<boolean>;
  recordMigration(record: MigrationRecord): Promise<void>;
}

export const MIGRATION_NAME = /^[a-z][a-z0-9-]{2,60}$/;

export async function runOnce(ledger: MigrationLedger, name: string, now: string, work: () => Promise<Record<string, number>>): Promise<Record<string, number>> {
  if (!MIGRATION_NAME.test(name)) throw new Error(`a migration is named in lowercase words joined by dashes, not "${name}"`);
  if (await ledger.hasMigration(name)) return {};
  const result = await work();
  await ledger.recordMigration({ name, at: now, result });
  return result;
}

export function memoryLedger(): MigrationLedger & { records: MigrationRecord[] } {
  const records: MigrationRecord[] = [];
  return {
    records,
    async hasMigration(name) { return records.some((record) => record.name === name); },
    async recordMigration(record) { records.push({ ...record }); },
  };
}
