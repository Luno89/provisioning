import type { Server as SocketServer } from 'socket.io';
import { MACHINE_JOINS_CHANGED } from '@koala/engine-core/machine-join';
import { holdsAccounts, runOnce, servesTenants, type Database, type RoleConfig, type SecretKey } from '../../platform/index.js';
import { RootMachines, type InstanceRecord } from '../../instances/index.js';
import { MachineAccounts, type KoalaPlace, type KoalaPlacer } from '../services/MachineAccounts.js';
import { MachineMirror } from '../services/MachineMirror.js';
import { MachineService, type MachineDeps } from '../services/MachineService.js';
import { MachineClusters } from '../services/MachineClusters.js';
import { wireMachineAccounts, type AccountSockets } from './accounts.js';
import type { WorkTokenTrust } from './sockets.js';
import { userRoom } from '../../engine-host/temporal/stream-worker.js';

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
}

export interface InstancesNow {
  service?: {
    koalaOf(ownerId: string): Promise<KoalaPlace | undefined>;
    caller(instanceId: string, credential: string): Promise<{ ownerId: string } | undefined>;
    placeOn?: KoalaPlacer['placeOn'] | undefined;
  } | undefined;
  tellInstance?: ((instanceId: string, event: string) => void) | undefined;
}

export interface MachineSides {
  accounts?: MachineAccounts | undefined;
  machines: MachineService;
  clusters?: MachineClusters | undefined;
  mirror?: MachineMirror | undefined;
  workTokens?: WorkTokenTrust | undefined;
  syncMachines?: (() => Promise<void>) | undefined;
  instanceCaller: (instanceId: string, credential: string) => Promise<{ ownerId: string } | undefined>;
  instanceArrived: (instance: Pick<InstanceRecord, 'id' | 'ownerId'>) => void;
}

export function machineSides(deps: MachineSidesDeps): MachineSides {
  const { role, db } = deps;
  const tenants = servesTenants(role);
  const ownerInstances = async (ownerId: string) => {
    for (const instance of await db.instances.getInstances(ownerId)) deps.instances()?.tellInstance?.(instance.id, 'machines:changed');
  };
  let toMachines: AccountSockets = { removed: () => false, koala: () => false, placeKoala: async () => false, online: () => false };
  let machines: MachineService | undefined;
  const accounts = holdsAccounts(role) && role.signing ? new MachineAccounts({
    store: db.machines,
    signing: role.signing,
    settings: { url: deps.publicUrl, meshLoginServer: deps.meshLoginServer, registry: deps.registry },
    koala: { of: async (ownerId) => deps.instances()?.service?.koalaOf(ownerId) },
    followers: { joined: (machine) => ownerInstances(machine.ownerId), removed: (machine) => ownerInstances(machine.ownerId), changed: (ownerId) => ownerInstances(ownerId) },
    toOwner: { machinesChanged: (ownerId) => { deps.io.to(userRoom(ownerId)).emit(MACHINE_JOINS_CHANGED, {}); } },
    toMachines: { removed: (deviceId) => toMachines.removed(deviceId), koala: (deviceId, koala) => toMachines.koala(deviceId, koala), placeKoala: (deviceId, placed) => toMachines.placeKoala(deviceId, placed), online: (deviceId) => toMachines.online(deviceId) },
    placer: { placeOn: async (ownerId, machine, name) => (deps.instances()?.service?.placeOn ? deps.instances()!.service!.placeOn!(ownerId, machine, name) : { ok: false, status: 503, error: 'this Koala holds no instances to put on machines' }) },
    mesh: deps.mesh,
  }) : undefined;
  const clusters = tenants ? new MachineClusters({ store: db.infrastructure, accounts: db.accounts, dataKey: deps.dataKey, koalaMachineId: deps.koalaMachineId }) : undefined;
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
  if (accounts) toMachines = wireMachineAccounts({ io: deps.io, db, accounts: () => accounts });
  return {
    accounts,
    machines,
    clusters,
    mirror,
    syncMachines,
    workTokens: tenants && role.trusted && role.instance ? { keys: role.trusted, audience: role.instance.id } : undefined,
    instanceCaller: async (instanceId, credential) => deps.instances()?.service?.caller(instanceId, credential),
    instanceArrived: (instance) => {
      void accounts?.tellKoala(instance.ownerId).catch((err: Error) => console.warn(`[machines] ${instance.id}'s owner's machines could not be told where it is: ${err.message}`));
    },
  };
}
