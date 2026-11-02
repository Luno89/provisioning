import type { LocalAgentDeviceMetadata } from '../../platform/index.js';
import { copied, MemoryRecords } from '../../platform/testing/memory-records.js';
import type { MachineJoinCode } from '../lib/machines.js';
import type { DeviceChange, MachinesStore } from '../store.js';

export class MemoryMachinesStore implements MachinesStore {
  private readonly devices = new MemoryRecords<LocalAgentDeviceMetadata>();
  private readonly joinCodes = new Map<string, MachineJoinCode>();

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
  }

  async saveMachineJoinCode(code: MachineJoinCode): Promise<void> {
    this.joinCodes.set(code.hash, copied(code));
  }

  async takeMachineJoinCode(hash: string): Promise<MachineJoinCode | undefined> {
    const code = this.joinCodes.get(hash);
    this.joinCodes.delete(hash);
    return code;
  }
}
