import { type AreaStore, fromDoc, toDoc } from '../platform/lib/collection.js';
import type { Collection, Db, Document } from 'mongodb';
import type { LocalAgentDeviceMetadata } from '../platform/index.js';
import type { MachineJoinCode } from './lib/machines.js';

export interface DeviceChange {
  set?: Partial<LocalAgentDeviceMetadata> | undefined;
  unset?: readonly (keyof LocalAgentDeviceMetadata & string)[] | undefined;
  when?: Partial<Record<keyof LocalAgentDeviceMetadata & string, string | null>> | undefined;
}

export interface MachinesStore extends AreaStore {
  getLocalAgentDevices(): Promise<LocalAgentDeviceMetadata[]>;
  saveLocalAgentDevice(device: LocalAgentDeviceMetadata): Promise<void>;
  updateLocalAgentDevice(id: string, change: DeviceChange): Promise<boolean>;
  deleteLocalAgentDevice(id: string): Promise<void>;
  saveMachineJoinCode(code: MachineJoinCode): Promise<void>;
  takeMachineJoinCode(hash: string): Promise<MachineJoinCode | undefined>;
}

export class MongoMachinesStore implements MachinesStore {
  constructor(private readonly db: () => Db) {}

  private get localAgentDevices(): Collection<Document & { _id: string }> {
    return this.db().collection<Document & { _id: string }>('localAgentDevices');
  }

  private get machineJoinCodes(): Collection {
    return this.db().collection('machineJoinCodes');
  }

  async ensureIndexes(): Promise<void> {
    await this.machineJoinCodes.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  }

  async getLocalAgentDevices(): Promise<LocalAgentDeviceMetadata[]> {
    return (await this.localAgentDevices.find({}).toArray()).map(doc => fromDoc<LocalAgentDeviceMetadata>(doc));
  }

  async saveLocalAgentDevice(device: LocalAgentDeviceMetadata): Promise<void> {
    const { _id, ...filter } = toDoc(device);
    await this.localAgentDevices.replaceOne({ _id: device.id }, filter, { upsert: true });
  }

  async updateLocalAgentDevice(id: string, change: DeviceChange): Promise<boolean> {
    const filter: Record<string, unknown> = { _id: id };
    for (const [field, value] of Object.entries(change.when ?? {})) filter[field] = value === null ? { $exists: false } : value;
    const update: Record<string, unknown> = {};
    if (change.set && Object.keys(change.set).length) update.$set = change.set;
    if (change.unset?.length) update.$unset = Object.fromEntries(change.unset.map((field) => [field, '']));
    if (!Object.keys(update).length) return false;
    const result = await this.localAgentDevices.updateOne(filter as never, update);
    return result.matchedCount === 1;
  }

  async deleteLocalAgentDevice(id: string): Promise<void> {
    await this.localAgentDevices.deleteOne({ _id: id });
  }

  async saveMachineJoinCode(code: MachineJoinCode): Promise<void> {
    await this.machineJoinCodes.replaceOne({ _id: code.hash as never }, { ...code, expiresAt: new Date(code.expiresAt) }, { upsert: true });
  }

  async takeMachineJoinCode(hash: string): Promise<MachineJoinCode | undefined> {
    const doc = await this.machineJoinCodes.findOneAndDelete({ _id: hash as never });
    if (!doc) return undefined;
    return { hash, ownerId: doc.ownerId as string, expiresAt: (doc.expiresAt as Date).toISOString() };
  }
}
