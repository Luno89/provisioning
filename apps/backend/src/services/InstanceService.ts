import crypto from 'crypto';
import type { Database } from '../lib/db-interface.js';
import { INSTANCE_STATUSES, type InstanceRecord, type InstanceStatus } from '../lib/instances.js';

export const JOIN_TOKEN_TTL_SECONDS = 3600;

type Store = Pick<Database, 'saveJoinToken' | 'takeJoinToken' | 'getInstances' | 'saveInstance' | 'getUserById'>;

export interface InstanceSettings {
  rootUrl: string;
  rootPublicKeys: () => string[];
  meshLoginServer?: string | undefined;
  registry: string;
  imageTag: string;
  chartVersion: string;
}

export interface JoinBundle {
  instanceId: string;
  ownerId: string;
  rootUrl: string;
  rootPublicKeys: string;
  meshLoginServer: string;
  preAuthKey: string;
  registry: string;
  image: string;
  imageTag: string;
  chartUrl: string;
  credential: string;
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; status: 400 | 401 | 404 | 503; error: string };

const hash = (secret: string): string => crypto.createHash('sha256').update(secret).digest('hex');
const sameHash = (a: string, b: string): boolean => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const instanceIdFor = (ownerId: string): string => `inst-${hash(ownerId).slice(0, 12)}`;

export class InstanceService {
  constructor(
    private readonly store: Store,
    private readonly settings: InstanceSettings,
    private readonly mesh: { createPreAuthKey(ownerId: string, opts?: { reusable?: boolean; expirySeconds?: number }): Promise<{ key: string }> } | undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async save(instance: InstanceRecord, patch: Partial<InstanceRecord>): Promise<InstanceRecord> {
    const next = { ...instance, ...patch, updatedAt: this.now().toISOString() };
    await this.store.saveInstance(next);
    return next;
  }

  async createJoinToken(ownerId: string): Promise<{ token: string; command: string; expiresAt: string }> {
    const token = crypto.randomBytes(24).toString('base64url');
    const expiresAt = new Date(this.now().getTime() + JOIN_TOKEN_TTL_SECONDS * 1000).toISOString();
    const instanceId = instanceIdFor(ownerId);
    await this.store.saveJoinToken({ hash: hash(token), ownerId, instanceId, expiresAt });

    const existing = (await this.store.getInstances(ownerId))[0];
    const now = this.now().toISOString();
    await this.store.saveInstance({
      id: instanceId,
      ownerId,
      url: existing?.url ?? '',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      status: 'waiting',
      detail: 'Waiting for the machine to run the install command',
      ...(existing?.credentialHash ? { credentialHash: existing.credentialHash } : {}),
    });

    return { token, expiresAt, command: `curl -fsSL ${this.settings.rootUrl}/install.sh | sudo sh -s -- ${token}` };
  }

  async join(token: unknown, machine: unknown): Promise<Outcome<JoinBundle>> {
    if (typeof token !== 'string' || !token) return { ok: false, status: 400, error: 'send the join token as "token"' };
    const found = await this.store.takeJoinToken(hash(token));
    if (!found || found.expiresAt <= this.now().toISOString()) return { ok: false, status: 401, error: 'that join command has expired or was already used — make a new one from the app' };
    if (!this.mesh || !this.settings.meshLoginServer) return { ok: false, status: 503, error: 'this root has no mesh configured (MESH_LOGIN_SERVER), so no machine can join it' };
    if (!this.settings.registry) return { ok: false, status: 503, error: 'this root has no registry for machines to pull from (INSTANCE_REGISTRY)' };

    const credential = crypto.randomBytes(32).toString('base64url');
    const { key } = await this.mesh.createPreAuthKey(found.ownerId, { reusable: false, expirySeconds: JOIN_TOKEN_TTL_SECONDS });
    const instance = (await this.store.getInstances(found.ownerId)).find((entry) => entry.id === found.instanceId);
    const now = this.now().toISOString();
    await this.save(instance ?? { id: found.instanceId, ownerId: found.ownerId, url: '', createdAt: now, updatedAt: now }, {
      status: 'joined',
      detail: 'The machine has the install command and is setting itself up',
      credentialHash: hash(credential),
      machine: typeof machine === 'string' ? machine.slice(0, 120) : undefined,
    });

    return {
      ok: true,
      value: {
        instanceId: found.instanceId,
        ownerId: found.ownerId,
        rootUrl: this.settings.rootUrl,
        rootPublicKeys: this.settings.rootPublicKeys().join('\n'),
        meshLoginServer: this.settings.meshLoginServer,
        preAuthKey: key,
        registry: this.settings.registry,
        image: `${this.settings.registry}/nowrinkles/app`,
        imageTag: this.settings.imageTag,
        chartUrl: `${this.settings.rootUrl}/api/instances/chart.tgz`,
        credential,
      },
    };
  }

  private async authenticated(instanceId: unknown, credential: unknown): Promise<InstanceRecord | undefined> {
    if (typeof instanceId !== 'string' || typeof credential !== 'string' || !credential) return undefined;
    const instance = (await this.store.getInstances()).find((entry) => entry.id === instanceId);
    return instance?.credentialHash && sameHash(instance.credentialHash, hash(credential)) ? instance : undefined;
  }

  async release(instanceId: unknown, credential: unknown): Promise<Outcome<{ imageTag: string; chartVersion: string; chartUrl: string }>> {
    if (!await this.authenticated(instanceId, credential)) return { ok: false, status: 401, error: 'unknown instance or credential' };
    return { ok: true, value: { imageTag: this.settings.imageTag, chartVersion: this.settings.chartVersion, chartUrl: `${this.settings.rootUrl}/api/instances/chart.tgz` } };
  }

  async report(instanceId: unknown, credential: unknown, report: { status?: unknown; detail?: unknown; url?: unknown }): Promise<Outcome<InstanceRecord>> {
    const instance = await this.authenticated(instanceId, credential);
    if (!instance) return { ok: false, status: 401, error: 'unknown instance or credential' };
    if (!INSTANCE_STATUSES.includes(report.status as InstanceStatus)) return { ok: false, status: 400, error: `status is one of ${INSTANCE_STATUSES.join(', ')}` };
    let url = instance.url;
    if (report.url !== undefined) {
      try {
        const parsed = new URL(String(report.url));
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
        url = parsed.origin;
      } catch {
        return { ok: false, status: 400, error: 'url is the origin the instance answers on' };
      }
    }
    return { ok: true, value: await this.save(instance, { status: report.status as InstanceStatus, detail: typeof report.detail === 'string' ? report.detail.slice(0, 500) : undefined, url }) };
  }

  async mine(ownerId: string): Promise<{ id: string; status: InstanceStatus; detail?: string | undefined; url: string } | null> {
    const instance = (await this.store.getInstances(ownerId))[0];
    return instance ? { id: instance.id, status: instance.status ?? (instance.url ? 'ready' : 'waiting'), detail: instance.detail, url: instance.url } : null;
  }
}
