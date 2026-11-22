import type { LocalAgentDeviceMetadata } from '../../platform/index.js';
import { collectionIn, copied, MemoryRecords, type Collections } from '../../platform/testing/memory-records.js';
import type { MachineJoinCode } from '../lib/machines.js';
import type { Watching } from '../../platform/index.js';
import type { DeviceChange, DeviceWait, JoinChange, MachinesStore } from '../store.js';

const defined = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class MemoryMachinesStore implements MachinesStore {
  private readonly devices: MemoryRecords<LocalAgentDeviceMetadata>;
  private readonly joinCodes: Map<string, MachineJoinCode>;
  private readonly removalWatchers = new Set<(device: LocalAgentDeviceMetadata) => void>();
  private readonly deletionWatchers = new Set<(id: string) => void>();

  constructor(collections: Collections = new Map()) {
    this.devices = new MemoryRecords(collectionIn<LocalAgentDeviceMetadata>(collections, 'localAgentDevices'));
    this.joinCodes = collectionIn<MachineJoinCode>(collections, 'machineJoinCodes');
  }

  async ensureIndexes(): Promise<void> {}

  async getLocalAgentDevices(): Promise<LocalAgentDeviceMetadata[]> {
    return this.devices.all();
  }

  async saveLocalAgentDevice(device: LocalAgentDeviceMetadata): Promise<void> {
    this.devices.put(device);
  }

  async updateLocalAgentDevice(id: string, change: DeviceChange): Promise<boolean> {
    const set = change.set ?? {};
    const unset = change.unset ?? [];
    if (Object.keys(set).length === 0 && unset.length === 0) return false;
    return this.devices.change(id, (device) => {
      for (const [field, value] of Object.entries(change.when ?? {})) {
        if (value === null ? field in device : device[field] !== value) return undefined;
      }
      const next: LocalAgentDeviceMetadata = { ...device, ...set };
      for (const field of unset) delete next[field];
      return next;
    });
  }

  async deleteLocalAgentDevice(id: string): Promise<void> {
    this.devices.delete(id);
    for (const gone of this.deletionWatchers) gone(id);
  }

  async untilDeviceGone(id: string, stop: AbortSignal): Promise<DeviceWait> {
    if (stop.aborted) return 'stopped';
    if (!this.devices.all().some((device) => device.id === id)) return 'removed';
    return new Promise<DeviceWait>((done) => {
      const end = (wait: DeviceWait) => {
        this.deletionWatchers.delete(heard);
        stop.removeEventListener('abort', stopped);
        done(wait);
      };
      const heard = (deleted: string) => { if (deleted === id) end('removed'); };
      const stopped = () => end('stopped');
      this.deletionWatchers.add(heard);
      stop.addEventListener('abort', stopped, { once: true });
    });
  }

  async markDevicesRemoving(ownerId: string, startedAt: string): Promise<{ id: string; name: string }[]> {
    const owned = this.devices.all().filter((device) => device.ownerId === ownerId);
    for (const device of owned.filter((entry) => !entry.removal)) {
      this.devices.change(device.id, (current) => ({ ...current, removal: { startedAt } }));
      const marked = this.devices.all().find((entry) => entry.id === device.id);
      if (marked) for (const watcher of this.removalWatchers) queueMicrotask(() => watcher(marked));
    }
    return owned.map(({ id, name }) => ({ id, name }));
  }

  watchDeviceRemovals(on: (device: LocalAgentDeviceMetadata) => void): Watching {
    this.removalWatchers.add(on);
    return { ready: Promise.resolve(), close: async () => { this.removalWatchers.delete(on); } };
  }

  async saveMachineJoinCode(code: MachineJoinCode): Promise<void> {
    this.joinCodes.set(code.hash, defined(code));
  }

  async takeMachineJoinCode(hash: string, usedAt: string): Promise<MachineJoinCode | undefined> {
    const code = this.joinCodes.get(hash);
    if (!code || code.usedAt) return undefined;
    this.joinCodes.set(hash, { ...code, usedAt });
    return copied(code);
  }

  async getMachineJoin(hash: string): Promise<MachineJoinCode | undefined> {
    const code = this.joinCodes.get(hash);
    return code ? copied(code) : undefined;
  }

  async getReportedMachineJoins(ownerId: string): Promise<MachineJoinCode[]> {
    return [...this.joinCodes.values()].filter((code) => code.ownerId === ownerId && code.progress).map(copied);
  }

  async getMachineJoinsOf(deviceId: string): Promise<MachineJoinCode[]> {
    return [...this.joinCodes.values()].filter((code) => code.deviceId === deviceId).map(copied);
  }

  async updateMachineJoin(hash: string, change: JoinChange): Promise<boolean> {
    const code = this.joinCodes.get(hash);
    const set = change.set ?? {};
    const unset = change.unset ?? [];
    if (Object.keys(set).length === 0 && unset.length === 0) return false;
    if (!code) return false;
    const next: MachineJoinCode = defined({ ...code, ...set });
    for (const field of unset) delete next[field];
    this.joinCodes.set(hash, next);
    return true;
  }

  async deleteMachineJoin(hash: string): Promise<boolean> {
    return this.joinCodes.delete(hash);
  }

  async deleteMachineJoinsOf(deviceId: string, keep?: string): Promise<number> {
    const gone = [...this.joinCodes.values()].filter((code) => code.deviceId === deviceId && code.hash !== keep);
    for (const code of gone) this.joinCodes.delete(code.hash);
    return gone.length;
  }
}
