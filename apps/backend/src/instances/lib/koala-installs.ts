import { KOALA_INSTALL_LAST_STAGE, type KoalaInstallState, type KoalaInstallView } from '@koala/engine-core/koala-install';
import type { MachineProgress } from '@koala/engine-core/machine-progress';
import type { InstanceStatus } from './instances.js';

export interface KoalaInstallRecord {
  id: string;
  machineId: string;
  state: KoalaInstallState;
  stage?: string | undefined;
  title?: string | undefined;
  line?: string | undefined;
  why?: string | undefined;
  imageTag?: string | undefined;
  askedAt?: string | undefined;
  at: string;
}

export interface InstallPatch {
  install: KoalaInstallRecord;
  status: InstanceStatus;
  detail: string;
  url?: string | undefined;
}

export const koalaInstallWorkflowId = (installId: string): string => `koala-install-${installId}`;

export const KOALA_INSTALL_SIGNALS = { progress: 'koalaInstallProgress', reconnected: 'koalaInstallReconnected' } as const;

export const installUnfinished = (install: Pick<KoalaInstallRecord, 'state'> | undefined): boolean =>
  install?.state === 'asked' || install?.state === 'installing';

export const askedInstall = (id: string, machineId: string, at: string): KoalaInstallRecord => ({ id, machineId, state: 'asked', at });

export function askedAgain(install: KoalaInstallRecord, machine: string, at: string): InstallPatch {
  return {
    install: { ...install, askedAt: at, at },
    status: 'installing',
    detail: install.title ? `${machine} is putting Koala on itself: ${install.title}` : `Asking ${machine} to put Koala on itself`,
  };
}

const lastDone = (progress: MachineProgress): boolean =>
  progress.stage === KOALA_INSTALL_LAST_STAGE && (progress.state === 'done' || progress.state === 'already-done');

export function stageHeard(install: KoalaInstallRecord, progress: MachineProgress, machine: string, at: string): InstallPatch {
  const stage = { stage: progress.stage, title: progress.title };
  if (progress.state === 'failed') {
    const why = progress.why ?? 'it said no more';
    return { install: { ...install, ...stage, state: 'failed', line: undefined, why, at }, status: 'failed', detail: `Putting Koala on ${machine} stopped at ${progress.title}: ${why}` };
  }
  if (lastDone(progress)) {
    return { install: { ...install, ...stage, state: 'ready', line: undefined, why: undefined, at }, status: 'ready', detail: 'Ready', url: progress.url };
  }
  const line = progress.state === 'started' ? progress.line : undefined;
  return {
    install: { ...install, ...stage, state: 'installing', line, why: undefined, at },
    status: 'installing',
    detail: `${machine} is putting Koala on itself: ${progress.title}${line ? `, ${line}` : ''}`,
  };
}

const HEARD = ['state', 'stage', 'title', 'line', 'why', 'at'] as const;

export function installFields(patch: InstallPatch, at: string): Record<string, unknown> {
  return {
    ...Object.fromEntries(HEARD.map((field) => [`install.${field}`, patch.install[field]])),
    ...(patch.install.askedAt !== undefined ? { 'install.askedAt': patch.install.askedAt } : {}),
    status: patch.status,
    detail: patch.detail,
    updatedAt: at,
    ...(patch.url !== undefined ? { url: patch.url } : {}),
    ...(patch.status === 'ready' && patch.install.imageTag ? { running: patch.install.imageTag } : {}),
  };
}

export const installView =(install: KoalaInstallRecord): KoalaInstallView => ({
  id: install.id,
  machineId: install.machineId,
  state: install.state,
  ...(install.stage ? { stage: install.stage } : {}),
  ...(install.title ? { title: install.title } : {}),
  ...(install.line ? { line: install.line } : {}),
  ...(install.why ? { why: install.why } : {}),
  at: install.at,
});
