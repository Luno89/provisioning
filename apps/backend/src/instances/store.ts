import type { AreaStore } from '../platform/lib/collection.js';
import type { Collection, Db } from 'mongodb';
import type { InstanceRecord, JoinToken } from './lib/instances.js';
import type { PoolPolicy } from './lib/pool.js';

export interface InstancesStore extends AreaStore {
  claimHandoff(jti: string, expiresAt: string): Promise<boolean>;
  saveJoinToken(token: JoinToken): Promise<void>;
  takeJoinToken(hash: string): Promise<JoinToken | undefined>;
  getInstances(ownerId?: string): Promise<InstanceRecord[]>;
  saveInstance(instance: InstanceRecord): Promise<void>;
  deleteInstance(id: string): Promise<void>;
  getPoolPolicy(): Promise<PoolPolicy | undefined>;
  savePoolPolicy(policy: PoolPolicy): Promise<void>;
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
    await this.instanceRegistry.replaceOne({ _id: instance.id as never }, instance, { upsert: true });
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
}
