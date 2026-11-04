import type { LocalAgentDeviceMetadata } from '../../platform/index.js';
import type { MachinesStore } from '../store.js';
import type { AccountMachine } from './MachineAccounts.js';

export interface MachineMirrorDeps {
  store: Pick<MachinesStore, 'getLocalAgentDevices' | 'saveLocalAgentDevice' | 'updateLocalAgentDevice' | 'deleteLocalAgentDevice'>;
  root: { list(): Promise<AccountMachine[]> };
  machines: { adopt(machine: AccountMachine): Promise<void>; forget(machine: AccountMachine): Promise<void> };
}

const IDENTITY = ['ownerId', 'name', 'rootDir', 'os', 'meshIp', 'createdAt', 'lastSeenAt'] as const;

const identityOf = (machine: AccountMachine): Partial<LocalAgentDeviceMetadata> =>
  Object.fromEntries(IDENTITY.map((field) => [field, machine[field]])) as Partial<LocalAgentDeviceMetadata>;

export class MachineMirror {
  private syncing: Promise<void> = Promise.resolve();
  private again = false;

  constructor(private readonly deps: MachineMirrorDeps) {}

  sync(): Promise<void> {
    if (this.again) return this.syncing;
    this.again = true;
    this.syncing = this.syncing.then(async () => {
      this.again = false;
      await this.once();
    });
    return this.syncing;
  }

  private async once(): Promise<void> {
    const fromRoot = await this.deps.root.list();
    const here = new Map((await this.deps.store.getLocalAgentDevices()).map((device) => [device.id, device]));
    for (const machine of fromRoot) {
      const known = here.get(machine.id);
      here.delete(machine.id);
      if (known) {
        const changed = IDENTITY.filter((field) => known[field] !== machine[field]);
        if (changed.length) await this.deps.store.updateLocalAgentDevice(machine.id, { set: identityOf(machine), unset: changed.filter((field) => machine[field] === undefined) });
        continue;
      }
      await this.deps.store.saveLocalAgentDevice({ id: machine.id, ...identityOf(machine) } as LocalAgentDeviceMetadata);
      await this.deps.machines.adopt(machine).catch((err: Error) => console.warn(`[machines] ${machine.name} came from root, but its project could not be made: ${err.message}`));
    }
    for (const gone of here.values()) {
      await this.deps.store.deleteLocalAgentDevice(gone.id);
      await this.deps.machines.forget({ id: gone.id, ownerId: gone.ownerId, name: gone.name, rootDir: gone.rootDir, createdAt: gone.createdAt });
    }
  }
}
