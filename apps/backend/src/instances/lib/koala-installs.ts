import { KOALA_INSTALL_LAST_STAGE, type KoalaInstallState, type KoalaStop, type KoalaInstallView, type ProvisionReport } from '@koala/engine-core/koala-install';
import type { MachineProgress } from '@koala/engine-core/machine-progress';
import type { InstanceStatus } from './instances.js';
import { setupHeard, setupSaid, type InstanceSetup } from './instance-setup.js';

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
  revision?: number | undefined;
  at: string;
}

export interface InstallPatch {
  install: KoalaInstallRecord;
  status: InstanceStatus;
  detail: string;
  url?: string | undefined;
  setup?: InstanceSetup | undefined;
}

export const koalaInstallWorkflowId = (installId: string): string => `koala-install-${installId}`;

export const KOALA_INSTALL_SIGNALS = { progress: 'koalaInstallProgress', setup: 'koalaInstallSetup', reconnected: 'koalaInstallReconnected' } as const;

export const installUnfinished = (install: Pick<KoalaInstallRecord, 'state'> | undefined): boolean =>
  install?.state === 'asked' || install?.state === 'installing';

export function installToStop(instance: { install?: KoalaInstallRecord | undefined }): KoalaStop | undefined {
  const { install } = instance;
  if (!install || install.state !== 'failed') return undefined;
  return { installId: install.id };
}

export const askedInstall = (id: string, machineId: string, at: string): KoalaInstallRecord =>
  ({ id, machineId, state: 'asked', at });

const putting = (machine: string): string => `${machine} is putting Koala on itself`;

const puttingSaid = (install: KoalaInstallRecord, machine: string): string =>
  (install.title ? `${putting(machine)}: ${install.title}${install.line ? `, ${install.line}` : ''}` : `Asking ${machine} to put Koala on itself`);

export function askedAgain(install: KoalaInstallRecord, machine: string, at: string): InstallPatch {
  return {
    install: { ...install, askedAt: at, at },
    status: 'installing',
    detail: install.title ? `${putting(machine)}: ${install.title}` : `Asking ${machine} to put Koala on itself`,
  };
}

const lastDone = (progress: MachineProgress): boolean =>
  progress.stage === KOALA_INSTALL_LAST_STAGE && (progress.state === 'done' || progress.state === 'already-done');

export interface InstallHeld {
  install: KoalaInstallRecord;
  setup?: InstanceSetup | undefined;
}

function settled(install: KoalaInstallRecord & { revision: number }, setup: InstanceSetup | undefined, machine: string, at: string): InstallPatch {
  const own = setup && setup.revision >= install.revision ? setup : undefined;
  if (!own) return { install: { ...install, state: 'installing', line: undefined, why: undefined, at }, status: 'installing', detail: `Koala on ${machine} is setting itself up` };
  const state: KoalaInstallState = own.state === 'failed' ? 'failed' : own.state === 'up' ? 'ready' : 'installing';
  return { install: { ...install, stage: own.stage, title: own.title, line: own.line, why: own.why, state, at }, ...setupSaid(own, machine) };
}

export function stageHeard({ install, setup }: InstallHeld, progress: MachineProgress, machine: string, at: string): InstallPatch {
  const stage = { stage: progress.stage, title: progress.title };
  if (progress.state === 'failed') {
    const why = progress.why ?? 'it said no more';
    return { install: { ...install, ...stage, state: 'failed', line: undefined, why, at }, status: 'failed', detail: `Putting Koala on ${machine} stopped at ${progress.title}: ${why}` };
  }
  if (lastDone(progress)) {
    if (progress.revision === undefined) throw new Error(`${machine} said Koala is on it without naming the chart revision it put on`);
    return { ...settled({ ...install, ...stage, revision: progress.revision }, setup, machine, at), url: progress.url };
  }
  const line = progress.state === 'started' ? progress.line : undefined;
  const heard: KoalaInstallRecord = { ...install, ...stage, state: 'installing', line, why: undefined, at };
  return { install: heard, status: 'installing', detail: puttingSaid(heard, machine) };
}

export const INSTALL_STOPPED_SAID = 'it was stopped before it finished';

export function installStopped(install: KoalaInstallRecord, machine: string, at: string): InstallPatch {
  return { install: { ...install, state: 'failed', line: undefined, why: INSTALL_STOPPED_SAID, at }, status: 'failed', detail: `Putting Koala on ${machine} stopped: ${INSTALL_STOPPED_SAID}` };
}

export function installSetupHeard(instance: InstallHeld & { machine?: string | undefined }, report: ProvisionReport, at: string): InstallPatch | undefined {
  const setup = setupHeard(instance.setup, report, at);
  if (!setup) return undefined;
  const machine = instance.machine ?? 'your machine';
  const { install } = instance;
  if (install.revision === undefined) return { install, status: 'installing', detail: puttingSaid(install, machine), setup };
  return { ...settled({ ...install, revision: install.revision }, setup, machine, at), setup };
}

const HEARD = ['state', 'stage', 'title', 'line', 'why', 'at', 'revision'] as const;

export function installFields(patch: InstallPatch, at: string): Record<string, unknown> {
  const heard = {
    ...Object.fromEntries(HEARD.map((field) => [`install.${field}`, patch.install[field]])),
    ...(patch.install.askedAt !== undefined ? { 'install.askedAt': patch.install.askedAt } : {}),
  };
  return {
    ...heard,
    status: patch.status,
    detail: patch.detail,
    updatedAt: at,
    ...(patch.url !== undefined ? { url: patch.url } : {}),
    ...(patch.status === 'ready' && patch.install.imageTag ? { running: patch.install.imageTag } : {}),
    ...(patch.setup ? { setup: patch.setup } : {}),
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
