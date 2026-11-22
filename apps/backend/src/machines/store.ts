import { type AreaStore, fieldChanges, fromDoc, toDoc } from '../platform/lib/collection.js';
import type { Collection, Db, Document } from 'mongodb';
import { keepWrittenDocuments, watchDeletes, watchWrites, type Watching } from '../platform/lib/change-streams.js';
import type { LocalAgentDeviceMetadata } from '../platform/index.js';
import type { MachineJoinCode } from './lib/machines.js';

export interface JoinChange {
  set?: Partial<Pick<MachineJoinCode, 'deviceId' | 'connectedAt' | 'progress' | 'keptUntil'>> | undefined;
  unset?: readonly ('keptUntil')[] | undefined;
}

const NOTHING_TO_DROP: readonly unknown[] = [26, 27];

const joinOf = (doc: Document): MachineJoinCode => {
  const { _id, expiresAt, keptUntil, ...rest } = doc;
  return {
    ...(rest as Omit<MachineJoinCode, 'hash' | 'expiresAt' | 'keptUntil'>),
    hash: String(_id),
    expiresAt: (expiresAt as Date).toISOString(),
    ...(keptUntil instanceof Date ? { keptUntil: keptUntil.toISOString() } : {}),
  };
};

export interface DeviceChange {
  set?: Partial<LocalAgentDeviceMetadata> | undefined;
  unset?: readonly (keyof LocalAgentDeviceMetadata & string)[] | undefined;
  when?: Partial<Record<keyof LocalAgentDeviceMetadata & string, string | null>> | undefined;
}

export type DeviceWait = 'removed' | 'stopped';

export interface MachinesStore extends AreaStore {
  getLocalAgentDevices(): Promise<LocalAgentDeviceMetadata[]>;
  saveLocalAgentDevice(device: LocalAgentDeviceMetadata): Promise<void>;
  updateLocalAgentDevice(id: string, change: DeviceChange): Promise<boolean>;
  deleteLocalAgentDevice(id: string): Promise<void>;
  markDevicesRemoving(ownerId: string, startedAt: string): Promise<{ id: string; name: string }[]>;
  watchDeviceRemovals(on: (device: LocalAgentDeviceMetadata) => void): Watching;
  untilDeviceGone(id: string, stop: AbortSignal): Promise<DeviceWait>;
  saveMachineJoinCode(code: MachineJoinCode): Promise<void>;
  takeMachineJoinCode(hash: string, usedAt: string): Promise<MachineJoinCode | undefined>;
  getMachineJoin(hash: string): Promise<MachineJoinCode | undefined>;
  getReportedMachineJoins(ownerId: string): Promise<MachineJoinCode[]>;
  getMachineJoinsOf(deviceId: string): Promise<MachineJoinCode[]>;
  updateMachineJoin(hash: string, change: JoinChange): Promise<boolean>;
  deleteMachineJoin(hash: string): Promise<boolean>;
  deleteMachineJoinsOf(deviceId: string, keep?: string): Promise<number>;
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
    await keepWrittenDocuments(this.db(), ['localAgentDevices']);
    await this.machineJoinCodes.updateMany(
      { keptUntil: { $exists: false }, progress: { $exists: false } },
      [{ $set: { keptUntil: '$expiresAt', id: { $ifNull: ['$id', { $toString: '$_id' }] } } }],
    );
    await this.machineJoinCodes.dropIndex('expiresAt_1').catch((err: { code?: unknown }) => {
      if (!NOTHING_TO_DROP.includes(err.code)) throw err;
    });
    await this.machineJoinCodes.createIndex({ keptUntil: 1 }, { expireAfterSeconds: 0 });
    await this.machineJoinCodes.createIndex({ ownerId: 1 });
    await this.machineJoinCodes.createIndex({ deviceId: 1 }, { sparse: true });
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
    const update = fieldChanges({ ...(change.set ?? {}), ...Object.fromEntries((change.unset ?? []).map((field) => [field, undefined])) });
    if (!update.$set && !update.$unset) return false;
    const result = await this.localAgentDevices.updateOne(filter as never, update);
    return result.matchedCount === 1;
  }

  async deleteLocalAgentDevice(id: string): Promise<void> {
    await this.localAgentDevices.deleteOne({ _id: id });
  }

  async markDevicesRemoving(ownerId: string, startedAt: string): Promise<{ id: string; name: string }[]> {
    await this.localAgentDevices.updateMany({ ownerId, removal: { $exists: false } }, { $set: { removal: { startedAt } } });
    return (await this.localAgentDevices.find({ ownerId }, { projection: { name: 1 } }).toArray()).map((doc) => ({ id: doc._id, name: String(doc.name) }));
  }

  watchDeviceRemovals(on: (device: LocalAgentDeviceMetadata) => void): Watching {
    return watchWrites(() => this.localAgentDevices, { removal: { $exists: true } }, (doc) => on(fromDoc<LocalAgentDeviceMetadata>(doc)));
  }

  async untilDeviceGone(id: string, stop: AbortSignal): Promise<DeviceWait> {
    if (stop.aborted) return 'stopped';
    let ended!: (wait: DeviceWait) => void;
    const waited = new Promise<DeviceWait>((done) => { ended = done; });
    const watching = watchDeletes(() => this.localAgentDevices, (deleted) => { if (deleted === id) ended('removed'); });
    const stopped = () => ended('stopped');
    stop.addEventListener('abort', stopped, { once: true });
    try {
      await Promise.race([watching.ready, waited]);
      if (!(await this.localAgentDevices.findOne({ _id: id }, { projection: { _id: 1 } }))) ended('removed');
      return await waited;
    } finally {
      stop.removeEventListener('abort', stopped);
      await watching.close();
    }
  }

  async saveMachineJoinCode(code: MachineJoinCode): Promise<void> {
    const { hash, expiresAt, keptUntil, ...rest } = code;
    await this.machineJoinCodes.replaceOne({ _id: hash as never }, { ...rest, expiresAt: new Date(expiresAt), ...(keptUntil ? { keptUntil: new Date(keptUntil) } : {}) }, { upsert: true });
  }

  async takeMachineJoinCode(hash: string, usedAt: string): Promise<MachineJoinCode | undefined> {
    const doc = await this.machineJoinCodes.findOneAndUpdate({ _id: hash as never, usedAt: { $exists: false } }, { $set: { usedAt } });
    return doc ? joinOf(doc) : undefined;
  }

  async getMachineJoin(hash: string): Promise<MachineJoinCode | undefined> {
    const doc = await this.machineJoinCodes.findOne({ _id: hash as never });
    return doc ? joinOf(doc) : undefined;
  }

  async getReportedMachineJoins(ownerId: string): Promise<MachineJoinCode[]> {
    return (await this.machineJoinCodes.find({ ownerId, progress: { $exists: true } }).toArray()).map(joinOf);
  }

  async getMachineJoinsOf(deviceId: string): Promise<MachineJoinCode[]> {
    return (await this.machineJoinCodes.find({ deviceId }).toArray()).map(joinOf);
  }

  async updateMachineJoin(hash: string, change: JoinChange): Promise<boolean> {
    const { keptUntil, ...set } = change.set ?? {};
    const update = fieldChanges({
      ...set,
      ...(keptUntil ? { keptUntil: new Date(keptUntil) } : {}),
      ...Object.fromEntries((change.unset ?? []).map((field) => [field, undefined])),
    });
    if (!update.$set && !update.$unset) return false;
    return (await this.machineJoinCodes.updateOne({ _id: hash as never }, update)).matchedCount === 1;
  }

  async deleteMachineJoin(hash: string): Promise<boolean> {
    return (await this.machineJoinCodes.deleteOne({ _id: hash as never })).deletedCount === 1;
  }

  async deleteMachineJoinsOf(deviceId: string, keep?: string): Promise<number> {
    return (await this.machineJoinCodes.deleteMany({ deviceId, ...(keep ? { _id: { $ne: keep as never } } : {}) })).deletedCount;
  }
}
