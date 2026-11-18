import type { MachineProgress } from '@koala/engine-core/machine-progress';
import type { KoalaInstallState } from '@koala/engine-core/koala-install';
import { createDatabase, type Database } from '../platform/index.js';
import { askedAgain, installFields, installUnfinished, stageHeard, type InstallPatch, type InstanceRecord } from '../instances/index.js';
import { hostSettings } from './host-settings.js';

export type InstallAnswer = KoalaInstallState | 'replaced';

export interface KoalaInstallDeps {
  db(): Promise<{ db: Pick<Database, 'instances'>; close(): Promise<void> }>;
  now(): Date;
}

const hostDb: KoalaInstallDeps['db'] = async () => {
  const { mongo, keys } = hostSettings();
  const db = createDatabase({ mongo, dataKey: keys.data });
  await db.init();
  return { db, close: () => db.close() };
};

async function withInstall(deps: KoalaInstallDeps, installId: string, change: (instance: InstanceRecord & { install: NonNullable<InstanceRecord['install']> }, at: string) => InstallPatch | undefined): Promise<InstallAnswer> {
  const opened = await deps.db();
  try {
    const instance = (await opened.db.instances.getInstances()).find((entry) => entry.install?.id === installId);
    if (!instance?.install) return 'replaced';
    if (!installUnfinished(instance.install)) return instance.install.state;
    const at = deps.now().toISOString();
    const patch = change(instance as InstanceRecord & { install: NonNullable<InstanceRecord['install']> }, at);
    if (!patch) return instance.install.state;
    const written = await opened.db.instances.updateInstall(instance.id, installId, installFields(patch, at));
    return written ? patch.install.state : 'replaced';
  } finally {
    await opened.close();
  }
}

export function koalaInstallActivities(deps: KoalaInstallDeps) {
  return {
    KoalaInstallAskActivity: ({ installId }: { installId: string }): Promise<InstallAnswer> =>
      withInstall(deps, installId, (instance, at) => askedAgain(instance.install, instance.machine ?? 'your machine', at)),
    KoalaInstallStageActivity: ({ installId, progress }: { installId: string; progress: MachineProgress }): Promise<InstallAnswer> =>
      withInstall(deps, installId, (instance, at) => stageHeard(instance.install, progress, instance.machine ?? 'your machine', at)),
  };
}

const onHost = koalaInstallActivities({ db: hostDb, now: () => new Date() });

export const { KoalaInstallAskActivity, KoalaInstallStageActivity } = onHost;
