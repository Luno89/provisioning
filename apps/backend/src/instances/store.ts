import type { AreaStore } from '../platform/index.js';
import type { Collection, Db } from 'mongodb';
import { stampServed, type InstanceRecord, type JoinToken } from './lib/instances.js';
import type { PoolPolicy } from './lib/pool.js';
import type { InstanceRelease, Withdrawal } from './lib/instance-updates.js';
import type { SignInKey } from './lib/oidc.js';
import type { ClientSession, LogoutDelivery, SessionRevocation } from './lib/sign-in-state.js';
import type { InstanceWatchRecord, Reach } from './lib/instance-watch.js';
import type { DependencyCheck, DependencyFinding } from './lib/dependency-findings.js';

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
  saveSignInKey(instanceId: string, key: SignInKey): Promise<boolean>;
  getHubSignInKey(): Promise<SignInKey | undefined>;
  saveHubSignInKey(key: SignInKey): Promise<void>;
  oidcUpsert(model: string, id: string, payload: Record<string, unknown>, expiresIn?: number): Promise<void>;
  oidcFind(model: string, id: string): Promise<Record<string, unknown> | undefined>;
  oidcFindBy(model: string, field: 'uid' | 'userCode', value: string): Promise<Record<string, unknown> | undefined>;
  oidcConsume(model: string, id: string): Promise<void>;
  oidcDestroy(model: string, id: string): Promise<void>;
  oidcRevokeGrant(grantId: string): Promise<void>;
  oidcForgetAccount(accountId: string): Promise<string[]>;
  enqueueLogout(delivery: LogoutDelivery): Promise<void>;
  pendingLogouts(): Promise<LogoutDelivery[]>;
  logoutDelivered(id: string): Promise<void>;
  logoutFailed(id: string, error: string, at: string): Promise<void>;
  saveClientSession(session: ClientSession): Promise<void>;
  getClientSession(sid: string): Promise<ClientSession | undefined>;
  dropClientSession(sid: string): Promise<void>;
  dropClientSessionsOf(subject: string): Promise<void>;
  recordRevocation(revocation: SessionRevocation): Promise<void>;
  getRevocations(): Promise<SessionRevocation[]>;
  getWatches(): Promise<InstanceWatchRecord[]>;
  getWatch(instanceId: string): Promise<InstanceWatchRecord | undefined>;
  saveReach(instance: { id: string; ownerId: string }, reach: Reach): Promise<void>;
  savePresence(instance: { id: string; ownerId: string }, presence: boolean): Promise<void>;
  saveNotifyWhenUnreachable(instance: { id: string; ownerId: string }, on: boolean): Promise<void>;
  deleteWatch(instanceId: string): Promise<void>;
  getDependencyFindings(): Promise<DependencyFinding[]>;
  saveDependencyFindings(findings: readonly DependencyFinding[]): Promise<void>;
  getDependencyCheck(): Promise<DependencyCheck | undefined>;
  saveDependencyCheck(check: DependencyCheck): Promise<void>;
  withdrawRelease(imageTag: string, withdrawal: Withdrawal | undefined): Promise<void>;
  withdrawalTold(key: string): Promise<boolean>;
  recordWithdrawalTold(key: string, ownerId: string, at: string): Promise<void>;
}

const asStored = (doc: Record<string, unknown> | null): Record<string, unknown> | undefined =>
  doc && typeof doc.payload === 'string' ? JSON.parse(doc.payload) as Record<string, unknown> : undefined;

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

  private get oidcArtifacts(): Collection {
    return this.db().collection('oidcArtifacts');
  }

  private get logoutDeliveries(): Collection {
    return this.db().collection('logoutDeliveries');
  }

  private get clientSessions(): Collection {
    return this.db().collection('clientSessions');
  }

  private get sessionRevocations(): Collection {
    return this.db().collection('sessionRevocations');
  }

  async ensureIndexes(): Promise<void> {
    await this.handoffs.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await this.instanceRegistry.createIndex({ ownerId: 1 });
    await this.instanceRegistry.createIndex({ name: 1 }, { unique: true, partialFilterExpression: { name: { $type: 'string' } } });
    await this.joinTokens.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await this.oidcArtifacts.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await this.oidcArtifacts.createIndex({ grantId: 1 });
    await this.oidcArtifacts.createIndex({ accountId: 1 });
    await this.oidcArtifacts.createIndex({ model: 1, uid: 1 });
    await this.oidcArtifacts.createIndex({ model: 1, userCode: 1 });
    await this.clientSessions.createIndex({ ownerId: 1 });
    await this.clientSessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
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
    await this.deleteWatch(id);
  }

  private get watches(): Collection {
    return this.db().collection('instanceWatches');
  }

  async getWatches(): Promise<InstanceWatchRecord[]> {
    return (await this.watches.find({}).toArray()).map(({ _id, ownerId: _owner, ...rest }) => ({ instanceId: String(_id), ...rest }) as InstanceWatchRecord);
  }

  async getWatch(instanceId: string): Promise<InstanceWatchRecord | undefined> {
    const doc = await this.watches.findOne({ _id: instanceId as never });
    if (!doc) return undefined;
    const { _id, ownerId: _owner, ...rest } = doc;
    return { instanceId, ...rest } as InstanceWatchRecord;
  }

  async saveReach(instance: { id: string; ownerId: string }, reach: Reach): Promise<void> {
    await this.watches.updateOne({ _id: instance.id as never }, { $set: { reach, ownerId: instance.ownerId } }, { upsert: true });
  }

  async savePresence(instance: { id: string; ownerId: string }, presence: boolean): Promise<void> {
    await this.watches.updateOne({ _id: instance.id as never }, { $set: { presence, ownerId: instance.ownerId } }, { upsert: true });
  }

  async saveNotifyWhenUnreachable(instance: { id: string; ownerId: string }, on: boolean): Promise<void> {
    await this.watches.updateOne({ _id: instance.id as never }, { $set: { notifyWhenUnreachable: on, ownerId: instance.ownerId } }, { upsert: true });
  }

  async deleteWatch(instanceId: string): Promise<void> {
    await this.watches.deleteOne({ _id: instanceId as never });
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

  async saveSignInKey(instanceId: string, key: SignInKey): Promise<boolean> {
    const updated = await this.instanceRegistry.updateOne({ _id: instanceId as never }, { $set: { signIn: key } });
    return updated.matchedCount > 0;
  }

  async getHubSignInKey(): Promise<SignInKey | undefined> {
    const doc = await this.db().collection('hubSignIn').findOne({ _id: 'hub' as never });
    return doc ? { jwk: doc.jwk, since: doc.since } as SignInKey : undefined;
  }

  async saveHubSignInKey(key: SignInKey): Promise<void> {
    await this.db().collection('hubSignIn').replaceOne({ _id: 'hub' as never }, { ...key }, { upsert: true });
  }

  async oidcUpsert(model: string, id: string, payload: Record<string, unknown>, expiresIn?: number): Promise<void> {
    const indexed = {
      model,
      payload: JSON.stringify(payload),
      ...(typeof payload.grantId === 'string' ? { grantId: payload.grantId } : {}),
      ...(typeof payload.uid === 'string' ? { uid: payload.uid } : {}),
      ...(typeof payload.userCode === 'string' ? { userCode: payload.userCode } : {}),
      ...(typeof payload.accountId === 'string' ? { accountId: payload.accountId } : {}),
      ...(typeof expiresIn === 'number' ? { expiresAt: new Date(Date.now() + expiresIn * 1000) } : {}),
    };
    await this.oidcArtifacts.replaceOne({ _id: `${model}:${id}` as never }, indexed, { upsert: true });
  }

  async oidcFind(model: string, id: string): Promise<Record<string, unknown> | undefined> {
    return asStored(await this.oidcArtifacts.findOne({ _id: `${model}:${id}` as never }));
  }

  async oidcFindBy(model: string, field: 'uid' | 'userCode', value: string): Promise<Record<string, unknown> | undefined> {
    return asStored(await this.oidcArtifacts.findOne({ model, [field]: value }));
  }

  async oidcConsume(model: string, id: string): Promise<void> {
    const found = await this.oidcFind(model, id);
    if (!found) return;
    await this.oidcArtifacts.updateOne({ _id: `${model}:${id}` as never }, { $set: { payload: JSON.stringify({ ...found, consumed: Math.floor(Date.now() / 1000) }) } });
  }

  async oidcDestroy(model: string, id: string): Promise<void> {
    await this.oidcArtifacts.deleteOne({ _id: `${model}:${id}` as never });
  }

  async oidcRevokeGrant(grantId: string): Promise<void> {
    await this.oidcArtifacts.deleteMany({ grantId });
    await this.oidcArtifacts.deleteOne({ _id: `Grant:${grantId}` as never });
  }

  async oidcForgetAccount(accountId: string): Promise<string[]> {
    const grants = await this.oidcArtifacts.find({ model: 'Grant', accountId }).toArray();
    const grantIds = grants.map((grant) => String(grant._id).slice('Grant:'.length));
    const clientIds = grants.map((grant) => asStored(grant)?.clientId).filter((id): id is string => typeof id === 'string');
    await this.oidcArtifacts.deleteMany({ $or: [{ accountId }, { grantId: { $in: grantIds } }] });
    return [...new Set(clientIds)];
  }

  async enqueueLogout(delivery: LogoutDelivery): Promise<void> {
    await this.logoutDeliveries.replaceOne({ _id: delivery.id as never }, { ...delivery }, { upsert: true });
  }

  async pendingLogouts(): Promise<LogoutDelivery[]> {
    const docs = await this.logoutDeliveries.find({}).sort({ revokedAt: 1 }).toArray();
    return docs.map(({ _id, ...rest }) => ({ id: String(_id), ...rest }) as LogoutDelivery);
  }

  async logoutDelivered(id: string): Promise<void> {
    await this.logoutDeliveries.deleteOne({ _id: id as never });
  }

  async logoutFailed(id: string, error: string, at: string): Promise<void> {
    await this.logoutDeliveries.updateOne({ _id: id as never }, { $set: { lastError: error, lastTriedAt: at }, $inc: { attempts: 1 } });
  }

  async saveClientSession(session: ClientSession): Promise<void> {
    const { id, ...rest } = session;
    await this.clientSessions.replaceOne({ _id: id as never }, { ...rest, expiresAt: new Date(session.expiresAt) }, { upsert: true });
  }

  async getClientSession(sid: string): Promise<ClientSession | undefined> {
    const doc = await this.clientSessions.findOne({ _id: sid as never });
    if (!doc) return undefined;
    const { _id, expiresAt, ...rest } = doc;
    return { id: String(_id), ...rest, expiresAt: (expiresAt as Date).toISOString() } as ClientSession;
  }

  async dropClientSession(sid: string): Promise<void> {
    await this.clientSessions.deleteOne({ _id: sid as never });
  }

  async dropClientSessionsOf(subject: string): Promise<void> {
    await this.clientSessions.deleteMany({ ownerId: subject });
  }

  async recordRevocation(revocation: SessionRevocation): Promise<void> {
    await this.sessionRevocations.updateOne(
      { _id: revocation.subject as never },
      [{ $set: { before: { $cond: [{ $gt: ['$before', revocation.before] }, '$before', revocation.before] } } }],
      { upsert: true },
    );
  }

  async getRevocations(): Promise<SessionRevocation[]> {
    const docs = await this.sessionRevocations.find({}).toArray();
    return docs.map((doc) => ({ subject: String(doc._id), before: String(doc.before) }));
  }

  async getDependencyFindings(): Promise<DependencyFinding[]> {
    const docs = await this.db().collection('dependencyFindings').find({}).toArray();
    return docs.map(({ _id, ...rest }) => ({ key: _id as unknown as string, ...rest }) as DependencyFinding);
  }

  async saveDependencyFindings(findings: readonly DependencyFinding[]): Promise<void> {
    const collection = this.db().collection('dependencyFindings');
    const keys = findings.map((finding) => finding.key);
    await collection.deleteMany({ _id: { $nin: keys as never[] } });
    for (const { key, ...rest } of findings) await collection.replaceOne({ _id: key as never }, rest, { upsert: true });
  }

  async getDependencyCheck(): Promise<DependencyCheck | undefined> {
    const doc = await this.db().collection('dependencyChecks').findOne({ _id: 'latest' as never });
    if (!doc) return undefined;
    const { _id, ...rest } = doc;
    return rest as unknown as DependencyCheck;
  }

  async saveDependencyCheck(check: DependencyCheck): Promise<void> {
    await this.db().collection('dependencyChecks').replaceOne({ _id: 'latest' as never }, { ...check }, { upsert: true });
  }
}

