import type { Server as SocketServer } from 'socket.io';
import type { Client } from '@temporalio/client';
import { MACHINE_JOINS_CHANGED } from '@koala/engine-core/machine-join';
import { KOALA_INSTALL_CHANGED } from '@koala/engine-core/koala-install';
import { getTemporalClient, holdsAccounts, QUEUES, runOnce, servesTenants, startedFor, watchingAll, type Database, type DependencyStates, type RoleConfig, type SecretKey, type Watching } from '../../platform/index.js';
import { KOALA_INSTALL_SIGNALS, koalaInstallWorkflowId, RootMachines, type InstanceRecord } from '../../instances/index.js';
import { KoalaInstallWorkflow } from '../../workflows/KoalaInstallWorkflow.js';
import { MachineAccounts, type KoalaPlace, type MachineRemovals } from '../services/MachineAccounts.js';
import { KoalaInstalls, type InstallPlaces, type InstallWorkflows } from '../services/KoalaInstalls.js';
import { MachineMirror } from '../services/MachineMirror.js';
import { MachineService, type MachineDeps } from '../services/MachineService.js';
import { MachineClusters } from '../services/MachineClusters.js';
import { wireMachineAccounts, type AccountSockets } from './accounts.js';
import type { WorkTokenTrust } from './sockets.js';
import { userRoom } from '../../engine-host/temporal/stream-worker.js';
import { MACHINE_UNINSTALLED_SIGNAL, removeAccountWorkflowId } from '../../accounts/index.js';

export interface MachineSidesDeps {
  role: RoleConfig;
  db: Database;
  io: Pick<SocketServer, 'of' | 'to'>;
  dataKey: SecretKey;
  publicUrl: string;
  meshLoginServer?: string | undefined;
  registry?: string | undefined;
  koalaMachineId?: string | undefined;
  mesh: NonNullable<ConstructorParameters<typeof MachineAccounts>[0]['mesh']>;
  devices: MachineDeps['devices'];
  projects: MachineDeps['projects'];
  bundle?: MachineDeps['bundle'];
  rootToken?: (() => Promise<string>) | undefined;
  side?: { hear(event: string, handler: () => void): void } | undefined;
  instances: () => InstancesNow | undefined;
  installWorkflows?: InstallWorkflows | undefined;
  machineRemovals?: MachineRemovals | undefined;
  dependencies: Pick<DependencyStates, 'whenAnswering'>;
}

const ended = (err: Error): void => {
  if (!/not found|already completed/i.test(err.message)) throw err;
};

export const temporalInstallWorkflows = (client: () => Promise<Client> = getTemporalClient, taskQueue: string = QUEUES.host): InstallWorkflows => {
  const handle = async (installId: string) => (await client()).workflow.getHandle(koalaInstallWorkflowId(installId));
  return {
    start: async (installId, ownerId) => {
      await (await client()).workflow.start(KoalaInstallWorkflow, { workflowId: koalaInstallWorkflowId(installId), taskQueue, args: [{ installId }], ...startedFor(ownerId) });
    },
    progress: async (installId, progress) => { await (await handle(installId)).signal(KOALA_INSTALL_SIGNALS.progress, progress); },
    setup: async (installId, report) => { await (await handle(installId)).signal(KOALA_INSTALL_SIGNALS.setup, report); },
    reconnected: async (installId) => { await (await handle(installId)).signal(KOALA_INSTALL_SIGNALS.reconnected); },
    cancel: async (installId) => { await (await handle(installId)).cancel().catch(ended); },
  };
};

export const temporalMachineRemovals = (client: () => Promise<Client> = getTemporalClient): MachineRemovals => ({
  uninstalled: async (ownerId, word) => { await (await client()).workflow.getHandle(removeAccountWorkflowId(ownerId)).signal(MACHINE_UNINSTALLED_SIGNAL, word); },
});

export interface InstancesNow {
  service?: {
    koalaOf(ownerId: string): Promise<KoalaPlace | undefined>;
    caller(instanceId: string, credential: string): Promise<{ ownerId: string } | undefined>;
  } | undefined;
  places?: InstallPlaces | undefined;
  tellInstance?: ((instanceId: string, event: string) => void) | undefined;
}

export interface MachineSides {
  accounts?: MachineAccounts | undefined;
  installs?: KoalaInstalls | undefined;
  machines: MachineService;
  clusters?: MachineClusters | undefined;
  mirror?: MachineMirror | undefined;
  workTokens?: WorkTokenTrust | undefined;
  syncMachines?: (() => Promise<void>) | undefined;
  instanceCaller: (instanceId: string, credential: string) => Promise<{ ownerId: string } | undefined>;
  instanceArrived: (instance: Pick<InstanceRecord, 'id' | 'ownerId'>) => void;
  watched?: Watching | undefined;
}

export function machineSides(deps: MachineSidesDeps): MachineSides {
  const { role, db } = deps;
  const tenants = servesTenants(role);
  const ownerInstances = async (ownerId: string) => {
    for (const instance of await db.instances.getInstances(ownerId)) deps.instances()?.tellInstance?.(instance.id, 'machines:changed');
  };
  let toMachines: Omit<AccountSockets, 'watched'> = { removed: () => false, koala: () => false, placeKoala: async () => false, stopKoala: () => false, online: () => false };
  let machines: MachineService | undefined;
  const installs = holdsAccounts(role) && role.signing ? new KoalaInstalls({
    devices: () => db.machines.getLocalAgentDevices(),
    places: () => deps.instances()?.places,
    workflows: deps.installWorkflows ?? temporalInstallWorkflows(),
    toMachines: { placeKoala: (deviceId, placed) => toMachines.placeKoala(deviceId, placed), stopKoala: (deviceId, stop) => toMachines.stopKoala(deviceId, stop) },
    toOwner: { installChanged: (ownerId) => { deps.io.to(userRoom(ownerId)).emit(KOALA_INSTALL_CHANGED, {}); } },
  }) : undefined;
  const accounts = holdsAccounts(role) && role.signing ? new MachineAccounts({
    store: db.machines,
    signing: role.signing,
    settings: { url: deps.publicUrl, meshLoginServer: deps.meshLoginServer, registry: deps.registry },
    koala: { of: async (ownerId) => deps.instances()?.service?.koalaOf(ownerId) },
    followers: { joined: (machine) => ownerInstances(machine.ownerId), removed: (machine) => ownerInstances(machine.ownerId), changed: (ownerId) => ownerInstances(ownerId) },
    toOwner: { machinesChanged: (ownerId) => { deps.io.to(userRoom(ownerId)).emit(MACHINE_JOINS_CHANGED, {}); installs?.wake(ownerId); } },
    toMachines: { removed: (deviceId) => toMachines.removed(deviceId), koala: (deviceId, koala) => toMachines.koala(deviceId, koala), online: (deviceId) => toMachines.online(deviceId) },
    installs,
    removals: deps.machineRemovals ?? temporalMachineRemovals(),
    mesh: deps.mesh,
  }) : undefined;
  const clusters = tenants ? new MachineClusters({ store: db.infrastructure, accounts: db.accounts, dataKey: deps.dataKey, io: deps.io, koalaMachineId: deps.koalaMachineId }) : undefined;
  const root = role.instance ? new RootMachines({ rootUrl: role.instance.rootUrl, instanceId: role.instance.id, token: deps.rootToken ?? (async () => '') }) : undefined;
  machines = new MachineService({
    store: db.machines,
    ...(deps.bundle ? { bundle: deps.bundle } : {}),
    devices: deps.devices,
    projects: deps.projects,
    ...(clusters ? { clusters } : {}),
    accounts: root ?? accounts ?? {
      createJoinCode: async () => { throw new Error('this Koala has no root to add machines through'); },
      remove: async () => false,
    },
  });
  const mirror = root ? new MachineMirror({ store: db.machines, root, machines }) : undefined;
  let syncMachines: (() => Promise<void>) | undefined;
  let watched: Watching | undefined;
  if (mirror && root) {
    const toRoot = () => runOnce(db.platform, 'machines-to-root', new Date().toISOString(), async () => root.adopt(await db.machines.getLocalAgentDevices()));
    let migrated = toRoot();
    syncMachines = () => {
      migrated = migrated.catch(() => toRoot());
      return migrated.then(() => mirror.sync());
    };
    const quietly = () => { syncMachines!().catch((err: Error) => console.warn(`[machines] this instance could not read its machines from root: ${err.message}`)); };
    deps.side?.hear('machines:changed', quietly);
    deps.side?.hear('connect', quietly);
  }
  if (accounts && installs) {
    const sockets = wireMachineAccounts({ io: deps.io, db, accounts: () => accounts, installs: () => installs, dependencies: deps.dependencies });
    toMachines = sockets;
    watched = watchingAll([sockets.watched, db.instances.watchInstalls((instance) => {
      installs.relay(instance).catch((err: Error) => console.warn(`[machines] ${instance.id}'s install could not be passed on: ${err.message}`));
    })]);
  }
  return {
    accounts,
    installs,
    machines,
    clusters,
    mirror,
    syncMachines,
    watched,
    workTokens: tenants && role.trusted && role.instance ? { keys: role.trusted, audience: role.instance.id } : undefined,
    instanceCaller: async (instanceId, credential) => deps.instances()?.service?.caller(instanceId, credential),
    instanceArrived: (instance) => {
      void accounts?.tellKoala(instance.ownerId).catch((err: Error) => console.warn(`[machines] ${instance.id}'s owner's machines could not be told where it is: ${err.message}`));
    },
  };
}
