import type { AreaStore } from '../platform/index.js';
import type { Collection, Db } from 'mongodb';
import { fieldChanges } from '../platform/lib/collection.js';
import { watchWrites, type Watching } from '../platform/lib/change-streams.js';
import { stampServed, type InstanceRecord } from './lib/instances.js';
import type { InstanceRelease, Withdrawal } from './lib/instance-updates.js';
import type { SignInKey } from './lib/oidc.js';
import type { ClientSession, LogoutDelivery, SessionRevocation } from './lib/sign-in-state.js';
import type { InstanceWatchRecord, Reach } from './lib/instance-watch.js';
import type { DependencyCheck, DependencyFinding } from './lib/dependency-findings.js';

export interface InstancesStore extends AreaStore {
  claimHandoff(jti: string, expiresAt: string): Promise<boolean>;
  dropJoinTokens(): Promise<number>;
  getInstances(ownerId?: string): Promise<InstanceRecord[]>;
  saveInstance(instance: InstanceRecord): Promise<void>;
  updateInstall(instanceId: string, installId: string, fields: Record<string, unknown>): Promise<boolean>;
  watchInstalls(on: (instance: InstanceRecord) => void): Watching;
  deleteInstance(id: string): Promise<void>;
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

export const RETIRED_JOIN_TOKENS = 'instanceJoinTokens';

export class MongoInstancesStore implements InstancesStore {
  constructor(private readonly db: () => Db) {}

  private get handoffs(): Collection {
    return this.db().collection('identityHandoffs');
  }

  private get instanceRegistry(): Collection {
    return this.db().collection('instances');
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

  async dropJoinTokens(): Promise<number> {
    const [found] = await this.db().listCollections({ name: RETIRED_JOIN_TOKENS }, { nameOnly: true }).toArray();
    if (!found) return 0;
    const rows = await this.db().collection(RETIRED_JOIN_TOKENS).countDocuments();
    await this.db().dropCollection(RETIRED_JOIN_TOKENS);
    return rows;
  }

  async getInstances(ownerId?: string): Promise<InstanceRecord[]> {
    const docs = await this.instanceRegistry.find(ownerId ? { ownerId } : {}).toArray();
    return docs.map(({ _id, ...rest }) => rest as unknown as InstanceRecord);
  }

  async saveInstance(instance: InstanceRecord): Promise<void> {
    await this.instanceRegistry.replaceOne({ _id: instance.id as never }, stampServed(instance), { upsert: true });
  }

  async updateInstall(instanceId: string, installId: string, fields: Record<string, unknown>): Promise<boolean> {
    const changed = await this.instanceRegistry.updateOne({ _id: instanceId as never, 'install.id': installId }, fieldChanges(fields));
    if (changed.matchedCount === 0) return false;
    if (fields.status === 'ready' && typeof fields.updatedAt === 'string') {
      await this.instanceRegistry.updateOne({ _id: instanceId as never, servedAt: { $exists: false } }, { $set: { servedAt: fields.updatedAt } });
    }
    return true;
  }

  watchInstalls(on: (instance: InstanceRecord) => void): Watching {
    return watchWrites(() => this.instanceRegistry, { install: { $exists: true } }, ({ _id, ...rest }) => on(rest as unknown as InstanceRecord));
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
    const doc = await this.releases.findOneAndUpdate(
      { _id: imageTag as never },
      { ...fieldChanges({ notes: undefined, hotfix: undefined, digest: undefined, chartSha256: undefined, dataVersion: undefined, ...rest }), $setOnInsert: { servedAt } },
      { upsert: true, returnDocument: 'after' },
    );
    const { _id, ...stored } = doc as Record<string, unknown>;
    return { imageTag, ...stored } as InstanceRelease;
  }

  async saveSignInKey(instanceId: string, key: SignInKey): Promise<boolean> {
    const updated = await this.instanceRegistry.updateOne({ _id: instanceId as never }, { $set: { signIn: key } });
    return updated.matchedCount > 0;
  }

  private get hubSignIn(): Collection<SignInKey & { _id: string }> {
    return this.db().collection<SignInKey & { _id: string }>('hubSignIn');
  }

  async getHubSignInKey(): Promise<SignInKey | undefined> {
    const doc = await this.hubSignIn.findOne({ _id: 'hub' });
    return doc ? { jwk: doc.jwk, since: doc.since } : undefined;
  }

  async saveHubSignInKey(key: SignInKey): Promise<void> {
    await this.hubSignIn.replaceOne({ _id: 'hub' }, { jwk: key.jwk, since: key.since }, { upsert: true });
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
