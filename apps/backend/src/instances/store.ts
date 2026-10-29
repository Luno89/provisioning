import type { AreaStore } from '../platform/index.js';
import type { Collection, Db } from 'mongodb';
import { stampServed, type InstanceRecord, type JoinToken } from './lib/instances.js';
import type { PoolPolicy } from './lib/pool.js';
import type { InstanceRelease, Withdrawal } from './lib/instance-updates.js';

export interface InstancesStore extends AreaStore {
  claimHandoff(jti: string, expiresAt: string): Promise<boolean>;
  saveJoinToken(token: JoinToken): Promise<void>;
  takeJoinToken(hash: string): Promise<JoinToken | undefined>;
  getInstances(ownerId?: string): Promise<InstanceRecord[]>;
  saveInstance(instance: InstanceRecord): Promise<void>;
  deleteInstance(id: string): Promise<void>;
  getPoolPolicy(): Promise<PoolPolicy | undefined>;
  savePoolPolicy(policy: PoolPolicy): Promise<void>;
  getReleases(): Promise<InstanceRelease[]>;
  recordRelease(release: InstanceRelease): Promise<InstanceRelease>;
  withdrawRelease(imageTag: string, withdrawal: Withdrawal | undefined): Promise<void>;
  withdrawalTold(key: string): Promise<boolean>;
  recordWithdrawalTold(key: string, ownerId: string, at: string): Promise<void>;
}

export class MongoInstancesStore implements InstancesStore {
  constructor(private readonly db: () => Db) {}

  private get handoffs(): Collection {
    return this.db().collection('identityHandoffs');
  }

  private get instanceRegistry(): Collection {
    return this.db().collection('instances');
  }

  private get joinTokens(): Collection {
    return this.db().collection('instanceJoinTokens');
  }

  private get releases(): Collection {
    return this.db().collection('instanceReleases');
  }

  async ensureIndexes(): Promise<void> {
    await this.handoffs.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await this.instanceRegistry.createIndex({ ownerId: 1 });
    await this.instanceRegistry.createIndex({ name: 1 }, { unique: true, partialFilterExpression: { name: { $type: 'string' } } });
    await this.joinTokens.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  }

  async claimHandoff(jti: string, expiresAt: string): Promise<boolean> {
    try {
      await this.handoffs.insertOne({ _id: jti as never, expiresAt: new Date(expiresAt) });
      return true;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return false;
      throw err;
    }
  }

  async saveJoinToken(token: JoinToken): Promise<void> {
    await this.joinTokens.replaceOne({ _id: token.hash as never }, { ...token, expiresAt: new Date(token.expiresAt) }, { upsert: true });
  }

  async takeJoinToken(hash: string): Promise<JoinToken | undefined> {
    const doc = await this.joinTokens.findOneAndDelete({ _id: hash as never });
    if (!doc) return undefined;
    return { hash, ownerId: doc.ownerId as string, instanceId: doc.instanceId as string, expiresAt: (doc.expiresAt as Date).toISOString(), ...(doc.move === true ? { move: true } : {}) };
  }

  async getInstances(ownerId?: string): Promise<InstanceRecord[]> {
    const docs = await this.instanceRegistry.find(ownerId ? { ownerId } : {}).toArray();
    return docs.map(({ _id, ...rest }) => rest as unknown as InstanceRecord);
  }

  async saveInstance(instance: InstanceRecord): Promise<void> {
    await this.instanceRegistry.replaceOne({ _id: instance.id as never }, stampServed(instance), { upsert: true });
  }

  async deleteInstance(id: string): Promise<void> {
    await this.instanceRegistry.deleteOne({ _id: id as never });
  }

  async getPoolPolicy(): Promise<PoolPolicy | undefined> {
    const doc = await this.db().collection('poolSettings').findOne({ _id: 'pool' as never });
    if (!doc) return undefined;
    const { _id, ...rest } = doc as Record<string, unknown>;
    return rest as unknown as PoolPolicy;
  }

  async savePoolPolicy(policy: PoolPolicy): Promise<void> {
    await this.db().collection('poolSettings').replaceOne({ _id: 'pool' as never }, { ...policy }, { upsert: true });
  }

  async getReleases(): Promise<InstanceRelease[]> {
    const docs = await this.releases.find({}).toArray();
    return docs.map(({ _id, ...rest }) => ({ imageTag: _id as unknown as string, ...rest }) as InstanceRelease);
  }

  async withdrawalTold(key: string): Promise<boolean> {
    return (await this.db().collection('releaseWithdrawalNotices').countDocuments({ _id: key as never }, { limit: 1 })) > 0;
  }

  async recordWithdrawalTold(key: string, ownerId: string, at: string): Promise<void> {
    await this.db().collection('releaseWithdrawalNotices').updateOne({ _id: key as never }, { $setOnInsert: { ownerId, at } }, { upsert: true });
  }

  async withdrawRelease(imageTag: string, withdrawal: Withdrawal | undefined): Promise<void> {
    await this.releases.updateOne({ _id: imageTag as never }, withdrawal ? { $set: { withdrawn: withdrawal } } : { $unset: { withdrawn: '' } });
  }

  async recordRelease(release: InstanceRelease): Promise<InstanceRelease> {
    const { imageTag, servedAt, ...rest } = release;
    const unset = Object.fromEntries((['notes', 'hotfix', 'digest', 'chartSha256'] as const).filter((field) => rest[field] === undefined).map((field) => [field, '']));
    const doc = await this.releases.findOneAndUpdate(
      { _id: imageTag as never },
      { $set: rest, $setOnInsert: { servedAt }, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { upsert: true, returnDocument: 'after' },
    );
    const { _id, ...stored } = doc as Record<string, unknown>;
    return { imageTag, ...stored } as InstanceRelease;
  }
}
