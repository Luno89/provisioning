import { createDatabase } from '../platform/lib/db-interface.js';
import { loadKeys } from '../platform/lib/keys.js';
import { HeadscaleService } from '../infrastructure/services/HeadscaleService.js';

export interface RootRemovalActivities {
  RootRemovalInstanceActivity(args: { ownerId: string }): Promise<{ poolInstanceId?: string | undefined }>;
  RootRemovalMeshActivity(args: { ownerId: string }): Promise<{ devices: number; user: boolean }>;
  RootRemovalRecordsActivity(args: { ownerId: string }): Promise<Record<string, number>>;
}

async function withDb<T>(work: (db: ReturnType<typeof createDatabase>) => Promise<T>): Promise<T> {
  const db = createDatabase();
  await db.init();
  try {
    return await work(db);
  } finally {
    await db.close();
  }
}

export async function RootRemovalInstanceActivity({ ownerId }: { ownerId: string }): Promise<{ poolInstanceId?: string | undefined }> {
  return withDb(async (db) => {
    const instance = (await db.instances.getInstances()).find((entry) => entry.ownerId === ownerId);
    return instance?.pool ? { poolInstanceId: instance.id } : {};
  });
}

export async function RootRemovalMeshActivity({ ownerId }: { ownerId: string }): Promise<{ devices: number; user: boolean }> {
  return new HeadscaleService(loadKeys(process.env).data, process.env.HEADSCALE_URL || 'http://localhost:8080').removeUser(ownerId);
}

export async function RootRemovalRecordsActivity({ ownerId }: { ownerId: string }): Promise<Record<string, number>> {
  return withDb((db) => db.accounts.removeAccountRecords(ownerId, { watermarkKeys: [], ingestIds: [], projectIds: [] }));
}
