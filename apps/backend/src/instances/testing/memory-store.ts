import { asStored } from '../../platform/testing/as-stored.js';
import { collectionIn, copied, type Collections } from '../../platform/testing/memory-records.js';
import { stampServed, type InstanceRecord } from '../lib/instances.js';
import type { InstanceRelease, Withdrawal } from '../lib/instance-updates.js';
import type { SignInKey } from '../lib/oidc.js';
import type { LogoutDelivery } from '../lib/sign-in-state.js';
import type { InstanceWatchRecord, Reach } from '../lib/instance-watch.js';
import type { DependencyCheck, DependencyFinding } from '../lib/dependency-findings.js';
import type { InstancesStore } from '../store.js';
import type { Watching } from '../../platform/lib/change-streams.js';

type Fields = Record<string, unknown>;

const duplicateKey = (what: string): Error => Object.assign(new Error(`E11000 duplicate key error: ${what}`), { code: 11000 });

interface Artifact {
  model: string;
  payload: string;
  grantId?: string;
  uid?: string;
  userCode?: string;
  accountId?: string;
}


interface StoredWatch { ownerId: string; reach?: Reach; presence?: boolean; notifyWhenUnreachable?: boolean }

const RELEASE_FIELDS = ['notes', 'hotfix', 'digest', 'chartSha256', 'dataVersion'] as const;

export class MemoryInstancesStore implements InstancesStore {
  private readonly instances: Map<string, InstanceRecord>;
  private readonly watches: Map<string, StoredWatch>;
  private readonly releases = new Map<string, Fields>();
  private readonly artifacts: Map<string, Artifact>;
  private readonly logouts = new Map<string, LogoutDelivery>();
  private readonly logoutsTaken = new Set<string>();
  private readonly findings = new Map<string, Omit<DependencyFinding, 'key'>>();
  private check: DependencyCheck | undefined;
  private readonly withdrawalNotices: Map<string, { ownerId: string; at: string }>;
  private readonly installWatchers = new Set<(instance: InstanceRecord) => void>();

  constructor(collections: Collections = new Map()) {
    this.instances = collectionIn<InstanceRecord>(collections, 'instances');
    this.watches = collectionIn<StoredWatch>(collections, 'instanceWatches');
    this.artifacts = collectionIn<Artifact>(collections, 'oidcArtifacts');
    this.withdrawalNotices = collectionIn<{ ownerId: string; at: string }>(collections, 'releaseWithdrawalNotices');
  }

  async ensureIndexes(): Promise<void> {}

  async dropJoinTokens(): Promise<number> {
    return 0;
  }

  async getInstances(ownerId?: string): Promise<InstanceRecord[]> {
    return [...this.instances.values()].filter((instance) => !ownerId || instance.ownerId === ownerId).map(copied);
  }

  async saveInstance(instance: InstanceRecord): Promise<void> {
    if (typeof instance.name === 'string') {
      const taken = [...this.instances.values()].some((other) => other.id !== instance.id && other.name === instance.name);
      if (taken) throw duplicateKey(`name: "${instance.name}"`);
    }
    const stored = asStored(copied(stampServed(instance)));
    this.instances.set(instance.id, stored);
    if (stored.install) for (const watcher of this.installWatchers) queueMicrotask(() => watcher(copied(stored)));
  }

  async updateInstall(instanceId: string, installId: string, fields: Record<string, unknown>): Promise<boolean> {
    const found = this.instances.get(instanceId);
    if (!found?.install || found.install.id !== installId) return false;
    const next = copied(found) as unknown as Record<string, unknown>;
    for (const [path, value] of Object.entries(fields)) {
      const steps = path.split('.');
      const key = steps.pop()!;
      const holder = steps.reduce((within, step) => (within[step] ??= {}) as Record<string, unknown>, next);
      if (value === undefined) delete holder[key];
      else holder[key] = copied(value);
    }
    if (fields.status === 'ready' && typeof fields.updatedAt === 'string' && next.servedAt === undefined) next.servedAt = fields.updatedAt;
    const stored = asStored(next as unknown as InstanceRecord);
    this.instances.set(instanceId, stored);
    for (const watcher of this.installWatchers) queueMicrotask(() => watcher(copied(stored)));
    return true;
  }

  watchInstalls(on: (instance: InstanceRecord) => void): Watching {
    this.installWatchers.add(on);
    return { ready: Promise.resolve(), close: async () => { this.installWatchers.delete(on); } };
  }

  async deleteInstance(id: string): Promise<void> {
    this.instances.delete(id);
    await this.deleteWatch(id);
  }

  async getWatches(): Promise<InstanceWatchRecord[]> {
    return [...this.watches].map(([instanceId, { ownerId: _owner, ...rest }]) => ({ instanceId, ...copied(rest) }) as InstanceWatchRecord);
  }

  async getWatch(instanceId: string): Promise<InstanceWatchRecord | undefined> {
    const watch = this.watches.get(instanceId);
    if (!watch) return undefined;
    const { ownerId: _owner, ...rest } = watch;
    return { instanceId, ...copied(rest) } as InstanceWatchRecord;
  }

  private watchFor(instance: { id: string; ownerId: string }, change: Partial<StoredWatch>): void {
    const existing = this.watches.get(instance.id);
    this.watches.set(instance.id, { ...existing, ...asStored(copied(change)), ownerId: instance.ownerId });
  }

  async saveReach(instance: { id: string; ownerId: string }, reach: Reach): Promise<void> {
    this.watchFor(instance, { reach });
  }

  async savePresence(instance: { id: string; ownerId: string }, presence: boolean): Promise<void> {
    this.watchFor(instance, { presence });
  }

  async saveNotifyWhenUnreachable(instance: { id: string; ownerId: string }, on: boolean): Promise<void> {
    this.watchFor(instance, { notifyWhenUnreachable: on });
  }

  async deleteWatch(instanceId: string): Promise<void> {
    this.watches.delete(instanceId);
  }

  async getReleases(): Promise<InstanceRelease[]> {
    return [...this.releases].map(([imageTag, stored]) => ({ imageTag, ...copied(stored) }) as InstanceRelease);
  }

  async withdrawalTold(key: string): Promise<boolean> {
    return this.withdrawalNotices.has(key);
  }

  async recordWithdrawalTold(key: string, ownerId: string, at: string): Promise<void> {
    if (!this.withdrawalNotices.has(key)) this.withdrawalNotices.set(key, { ownerId, at });
  }

  async withdrawRelease(imageTag: string, withdrawal: Withdrawal | undefined): Promise<void> {
    const stored = this.releases.get(imageTag);
    if (!stored) return;
    if (withdrawal) stored.withdrawn = asStored(copied(withdrawal));
    else delete stored.withdrawn;
  }

  async recordRelease(release: InstanceRelease): Promise<InstanceRelease> {
    const { imageTag, servedAt, ...rest } = release;
    const stored: Fields = this.releases.get(imageTag) ?? { servedAt };
    const fields: Fields = { ...Object.fromEntries(RELEASE_FIELDS.map((field) => [field, undefined])), ...rest };
    for (const [field, value] of Object.entries(fields)) {
      if (value === undefined) delete stored[field];
      else stored[field] = asStored(copied(value));
    }
    this.releases.set(imageTag, stored);
    return { imageTag, ...copied(stored) } as InstanceRelease;
  }

  async saveSignInKey(instanceId: string, key: SignInKey): Promise<boolean> {
    const instance = this.instances.get(instanceId);
    if (!instance) return false;
    instance.signIn = asStored(copied(key));
    return true;
  }

  async oidcUpsert(model: string, id: string, payload: Record<string, unknown>, _expiresIn?: number): Promise<void> {
    this.artifacts.set(`${model}:${id}`, {
      model,
      payload: JSON.stringify(payload),
      ...(typeof payload.grantId === 'string' ? { grantId: payload.grantId } : {}),
      ...(typeof payload.uid === 'string' ? { uid: payload.uid } : {}),
      ...(typeof payload.userCode === 'string' ? { userCode: payload.userCode } : {}),
      ...(typeof payload.accountId === 'string' ? { accountId: payload.accountId } : {}),
    });
  }

  async oidcFind(model: string, id: string): Promise<Record<string, unknown> | undefined> {
    const found = this.artifacts.get(`${model}:${id}`);
    return found ? JSON.parse(found.payload) as Record<string, unknown> : undefined;
  }

  async oidcFindBy(model: string, field: 'uid' | 'userCode', value: string): Promise<Record<string, unknown> | undefined> {
    const found = [...this.artifacts.values()].find((artifact) => artifact.model === model && artifact[field] === value);
    return found ? JSON.parse(found.payload) as Record<string, unknown> : undefined;
  }

  async oidcConsume(model: string, id: string): Promise<void> {
    const found = this.artifacts.get(`${model}:${id}`);
    if (!found) return;
    found.payload = JSON.stringify({ ...JSON.parse(found.payload) as Record<string, unknown>, consumed: Math.floor(Date.now() / 1000) });
  }

  async oidcDestroy(model: string, id: string): Promise<void> {
    this.artifacts.delete(`${model}:${id}`);
  }

  async oidcRevokeGrant(grantId: string): Promise<void> {
    for (const [key, artifact] of [...this.artifacts]) if (artifact.grantId === grantId) this.artifacts.delete(key);
    this.artifacts.delete(`Grant:${grantId}`);
  }

  async oidcGrantsOf(accountId: string): Promise<Record<string, unknown>[]> {
    return [...this.artifacts.values()].filter((artifact) => artifact.model === 'Grant' && artifact.accountId === accountId).map((artifact) => JSON.parse(artifact.payload) as Record<string, unknown>);
  }

  async oidcForgetAccount(accountId: string): Promise<string[]> {
    const grants = [...this.artifacts].filter(([, artifact]) => artifact.model === 'Grant' && artifact.accountId === accountId);
    const grantIds = grants.map(([key]) => key.slice('Grant:'.length));
    const clientIds = grants.map(([, artifact]) => (JSON.parse(artifact.payload) as Record<string, unknown>).clientId).filter((id): id is string => typeof id === 'string');
    for (const [key, artifact] of [...this.artifacts]) {
      if (artifact.accountId === accountId || (artifact.grantId !== undefined && grantIds.includes(artifact.grantId))) this.artifacts.delete(key);
    }
    return [...new Set(clientIds)];
  }

  async enqueueLogout(delivery: LogoutDelivery): Promise<void> {
    const { id, ...rest } = delivery;
    this.logouts.set(id, { id, ...asStored(copied(rest)) });
  }

  async pendingLogouts(): Promise<LogoutDelivery[]> {
    return [...this.logouts.values()].map(copied).sort((a, b) => (a.revokedAt < b.revokedAt ? -1 : a.revokedAt > b.revokedAt ? 1 : 0));
  }

  async logoutDelivered(id: string): Promise<void> {
    this.logouts.delete(id);
  }

  async logoutFailed(id: string, error: string, at: string): Promise<void> {
    const delivery = this.logouts.get(id);
    if (!delivery) return;
    const attempts = delivery.attempts as number | null | undefined;
    if (attempts === null) throw new Error('Cannot apply $inc to a value of non-numeric type null');
    this.logouts.set(id, { ...delivery, lastError: error, lastTriedAt: at, attempts: (attempts ?? 0) + 1 });
  }

  async takeLogoutToken(jti: string, _until: Date): Promise<boolean> {
    if (this.logoutsTaken.has(jti)) return false;
    this.logoutsTaken.add(jti);
    return true;
  }

  async getDependencyFindings(): Promise<DependencyFinding[]> {
    return [...this.findings].map(([key, rest]) => ({ key, ...copied(rest) }));
  }

  async saveDependencyFindings(findings: readonly DependencyFinding[]): Promise<void> {
    const keys = new Set(findings.map((finding) => finding.key));
    for (const key of [...this.findings.keys()]) if (!keys.has(key)) this.findings.delete(key);
    for (const { key, ...rest } of findings) this.findings.set(key, asStored(copied(rest)));
  }

  async getDependencyCheck(): Promise<DependencyCheck | undefined> {
    return this.check ? copied(this.check) : undefined;
  }

  async saveDependencyCheck(check: DependencyCheck): Promise<void> {
    this.check = asStored(copied({ ...check }));
  }
}
