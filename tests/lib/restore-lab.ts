export interface RestoreRunNames {
  stamp: string;
  minio: string;
  probe: string;
  firstRoot: string;
  secondRoot: string;
  workflow: string;
  email: string;
  instanceId: string;
  backupUser: string;
}

export const restoreRunStamp = (now: number, random: string): string => `${now.toString(36)}${random}`.toLowerCase();

export function restoreRunNames(stamp: string): RestoreRunNames {
  if (!/^[a-z0-9]{4,24}$/.test(stamp)) throw new Error(`${stamp} is not a run stamp: 4 to 24 lowercase letters and digits`);
  return {
    stamp,
    minio: `nw-restore-minio-${stamp}`,
    probe: `restore-probe-${stamp}`,
    firstRoot: `restore-first-${stamp}`,
    secondRoot: `restore-second-${stamp}`,
    workflow: `restore-live-${stamp}`,
    email: `restore-live-${stamp}@example.com`,
    instanceId: `inst-restore-${stamp}`,
    backupUser: `restore${stamp}`,
  };
}
