import type { Server as SocketServer } from 'socket.io';
import { holdsAccounts, runOnce, servesTenants, type Database, type RoleConfig, type SecretKey } from '../../platform/index.js';
import { RootMachines, type InstanceRecord } from '../../instances/index.js';
import { COMBINED_AUDIENCE } from '../lib/work-tokens.js';
import { MachineAccounts, type KoalaPlace } from '../services/MachineAccounts.js';
import { MachineMirror } from '../services/MachineMirror.js';
import { MachineService, type MachineDeps } from '../services/MachineService.js';
import { wireMachineAccounts, type AccountSockets } from './accounts.js';
import type { WorkTokenTrust } from './sockets.js';

export interface MachineSidesDeps {
  role: RoleConfig;
  db: Database;
  io: Pick<SocketServer, 'of'>;
  dataKey: SecretKey;
  publicUrl: string;
  meshLoginServer?: string | undefined;
  mesh: NonNullable<ConstructorParameters<typeof MachineAccounts>[0]['mesh']>;
  devices: MachineDeps['devices'];
  projects: MachineDeps['projects'];
  bundle?: MachineDeps['bundle'];
  rootToken?: (() => Promise<string>) | undefined;
  side?: { hear(event: string, handler: () => void): void } | undefined;
  instances: () => InstancesNow | undefined;
}

export interface InstancesNow {
  service?: { koalaOf(ownerId: string): Promise<KoalaPlace | undefined>; caller(instanceId: string, credential: string): Promise<{ ownerId: string } | undefined> } | undefined;
  tellInstance?: ((instanceId: string, event: string) => void) | undefined;
}

export interface MachineSides {
  accounts?: MachineAccounts | undefined;
  machines: MachineService;
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
  let toMachines: AccountSockets = { removed: () => false, koala: () => false };
  let machines: MachineService | undefined;
  const accounts = holdsAccounts(role) && role.signing ? new MachineAccounts({
    store: db.machines,
    dataKey: deps.dataKey,
    signing: role.signing,
    settings: { url: deps.publicUrl, meshLoginServer: deps.meshLoginServer },
    koala: { of: async (ownerId) => (tenants ? { url: deps.publicUrl, audience: COMBINED_AUDIENCE } : deps.instances()?.service?.koalaOf(ownerId)) },
    followers: tenants
      ? { joined: (machine) => machines!.adopt(machine), removed: (machine) => machines!.forget(machine), changed: async () => undefined }
      : { joined: (machine) => ownerInstances(machine.ownerId), removed: (machine) => ownerInstances(machine.ownerId), changed: (ownerId) => ownerInstances(ownerId) },
    toMachines: { removed: (deviceId) => toMachines.removed(deviceId), koala: (deviceId, koala) => toMachines.koala(deviceId, koala) },
    mesh: deps.mesh,
  }) : undefined;
  const root = role.instance ? new RootMachines({ rootUrl: role.instance.rootUrl, instanceId: role.instance.id, token: deps.rootToken ?? (async () => '') }) : undefined;
  machines = new MachineService({
    store: db.machines,
    ...(deps.bundle ? { bundle: deps.bundle } : {}),
    devices: deps.devices,
    projects: deps.projects,
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
  if (accounts) toMachines = wireMachineAccounts({ io: deps.io, db, dataKey: deps.dataKey, accounts: () => accounts });
  return {
    accounts,
    machines,
    mirror,
    syncMachines,
    workTokens: tenants && role.trusted ? { keys: role.trusted, audience: role.instance?.id ?? COMBINED_AUDIENCE } : undefined,
    instanceCaller: async (instanceId, credential) => deps.instances()?.service?.caller(instanceId, credential),
    instanceArrived: (instance) => {
      void accounts?.tellKoala(instance.ownerId).catch((err: Error) => console.warn(`[machines] ${instance.id}'s owner's machines could not be told where it is: ${err.message}`));
    },
  };
}
