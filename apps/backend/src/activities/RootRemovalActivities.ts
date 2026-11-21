import { ApplicationFailure } from '@temporalio/common';
import { createDatabase } from '../platform/index.js';
import { hostSettings } from './host-settings.js';
import { HeadscaleService } from '../infrastructure/index.js';
import { inService, installUnfinished } from '../instances/index.js';

export interface RootRemovalInstance {
  installId?: string | undefined;
  koala?: string | undefined;
}

export interface RootRemovalActivities {
  RootRemovalInstanceActivity(args: { ownerId: string }): Promise<RootRemovalInstance>;
  RootRemovalMeshActivity(args: { ownerId: string }): Promise<{ devices: number; user: boolean }>;
  RootRemovalRecordsActivity(args: { ownerId: string }): Promise<Record<string, number>>;
}

async function withDb<T>(work: (db: ReturnType<typeof createDatabase>) => Promise<T>): Promise<T> {
  const { mongo, keys } = hostSettings();
  const db = createDatabase({ mongo, dataKey: keys.data });
  await db.init();
  try {
    return await work(db);
  } finally {
    await db.close();
  }
}

export async function RootRemovalInstanceActivity({ ownerId }: { ownerId: string }): Promise<RootRemovalInstance> {
  return withDb(async (db) => {
    const instance = (await db.instances.getInstances()).find((entry) => entry.ownerId === ownerId);
    if (!instance) return {};
    if (instance.install && installUnfinished(instance.install)) return { installId: instance.install.id };
    return inService(instance) ? { koala: instance.id } : {};
  });
}

export async function RootRemovalMeshActivity({ ownerId }: { ownerId: string }): Promise<{ devices: number; user: boolean }> {
  const { mesh, keys, dataDir } = hostSettings();
  if ('off' in mesh) throw ApplicationFailure.nonRetryable(mesh.off, 'NoMesh');
  return new HeadscaleService(keys.data, mesh, dataDir).removeUser(ownerId);
}

export async function RootRemovalRecordsActivity({ ownerId }: { ownerId: string }): Promise<Record<string, number>> {
  return withDb((db) => db.accounts.removeAccountRecords(ownerId, { watermarkKeys: [], ingestIds: [], projectIds: [] }));
}
