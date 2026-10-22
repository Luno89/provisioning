import { type AreaStore, fromDoc, toDoc } from '../platform/lib/collection.js';
import type { Collection, Db } from 'mongodb';
import type { LocalAgentDeviceMetadata } from '../platform/index.js';
import type { MachineJoinCode } from './lib/machines.js';

export interface MachinesStore extends AreaStore {
  getLocalAgentDevices(): Promise<LocalAgentDeviceMetadata[]>;
  saveLocalAgentDevice(device: LocalAgentDeviceMetadata): Promise<void>;
  deleteLocalAgentDevice(id: string): Promise<void>;
  saveMachineJoinCode(code: MachineJoinCode): Promise<void>;
  takeMachineJoinCode(hash: string): Promise<MachineJoinCode | undefined>;
}

export class MongoMachinesStore implements MachinesStore {
  constructor(private readonly db: () => Db) {}

  private get localAgentDevices(): Collection {
    return this.db().collection('localAgentDevices');
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
    const doc = toDoc(device);
    const id = doc._id;
    const { _id, ...filter } = doc;
    await this.localAgentDevices.replaceOne({ _id: id }, filter, { upsert: true });
  }

  async deleteLocalAgentDevice(id: string): Promise<void> {
    await this.localAgentDevices.deleteOne({ _id: id as any });
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
