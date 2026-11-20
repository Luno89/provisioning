import type { MachineProgress } from '@koala/engine-core/machine-progress';
import type { KoalaInstallState, ProvisionReport } from '@koala/engine-core/koala-install';
import { createDatabase, type Database } from '../platform/index.js';
import { askedAgain, installFields, installSetupHeard, installStopped, installUnfinished, stageHeard, type InstallPatch, type InstanceRecord } from '../instances/index.js';
import { hostSettings } from './host-settings.js';

export type InstallAnswer = KoalaInstallState | 'replaced';

export type InstallHeard = { progress: MachineProgress } | { setup: ProvisionReport };

export interface KoalaInstallDeps {
  db(): Promise<{ db: Pick<Database, 'instances'>; close(): Promise<void> }>;
  now(): Date;
}

type Installing = InstanceRecord & { install: NonNullable<InstanceRecord['install']> };

const hostDb: KoalaInstallDeps['db'] = async () => {
  const { mongo, keys } = hostSettings();
  const db = createDatabase({ mongo, dataKey: keys.data });
  await db.init();
  return { db, close: () => db.close() };
};

const machineOf = (instance: Installing): string => instance.machine ?? 'your machine';

async function withInstall(deps: KoalaInstallDeps, installId: string, change: (instance: Installing, at: string) => InstallPatch | undefined): Promise<InstallAnswer> {
  const opened = await deps.db();
  try {
    const instance = (await opened.db.instances.getInstances()).find((entry) => entry.install?.id === installId);
    if (!instance?.install) return 'replaced';
    if (!installUnfinished(instance.install)) return instance.install.state;
    const at = deps.now().toISOString();
    const installing = instance as Installing;
    const patch = change(installing, at);
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
      withInstall(deps, installId, (instance, at) => askedAgain(instance.install, machineOf(instance), at)),
    KoalaInstallStageActivity: ({ installId, ...heard }: { installId: string } & InstallHeard): Promise<InstallAnswer> =>
      withInstall(deps, installId, (instance, at) => ('setup' in heard
        ? installSetupHeard({ install: instance.install, setup: instance.setup, machine: machineOf(instance) }, heard.setup, at)
        : stageHeard(instance.install, heard.progress, machineOf(instance), at))),
    KoalaInstallStoppedActivity: ({ installId }: { installId: string }): Promise<InstallAnswer> =>
      withInstall(deps, installId, (instance, at) => installStopped(instance.install, machineOf(instance), at)),
  };
}

const onHost = koalaInstallActivities({ db: hostDb, now: () => new Date() });

export const { KoalaInstallAskActivity, KoalaInstallStageActivity, KoalaInstallStoppedActivity } = onHost;
