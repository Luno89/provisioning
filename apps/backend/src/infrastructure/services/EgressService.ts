import { randomUUID } from 'node:crypto';
import type { EgressGrantRecord, EgressRequest } from '@koala/harness-types';
import { failureOf } from '@koala/engine-core/failures';
import type { Reopening } from '@koala/engine-core/reopening';
import { keepTrying } from '../../platform/index.js';

export interface EgressStore {
  getEgressGrants(ownerId?: string): Promise<EgressGrantRecord[]>;
  saveEgressGrant(grant: EgressGrantRecord): Promise<void>;
  getEgressRequests(ownerId: string, filter?: { conversationId?: string | undefined; treeId?: string | undefined }): Promise<EgressRequest[]>;
  getEgressRequest(ownerId: string, id: string): Promise<EgressRequest | undefined>;
  saveEgressRequest(request: EgressRequest): Promise<void>;
}

export interface EgressProxy {
  sync(grants: readonly EgressGrantRecord[]): Promise<void>;
}

export type EgressDecision =
  | { ok: true; request?: EgressRequest | undefined; grant?: EgressGrantRecord | undefined }
  | { ok: false; status: 404 | 409 | 502; error: string };

export interface ProxyBehind {
  since: string;
  reason: string;
  refused?: true | undefined;
}

export interface EgressDeps {
  store: EgressStore;
  proxy: EgressProxy;
  now?: () => string;
  newId?: () => string;
  again?: () => Reopening;
  log?: (message: string) => void;
}

export class EgressService {
  private behind: ProxyBehind | undefined;
  private retrying = false;

  constructor(private readonly deps: EgressDeps) {}

  proxyBehindSince(): ProxyBehind | undefined {
    return this.behind;
  }

  keepSynced(): Promise<boolean> {
    if (this.retrying) return Promise.resolve(false);
    return keepTrying('[egress] the proxy does not hold the current grants yet', async () => {
      try {
        await this.syncProxy();
      } catch (err) {
        this.fellBehind(err);
        this.retrying = true;
        throw err;
      }
      this.retrying = false;
    }, this.deps.log ?? ((message) => console.warn(message)), (reason) => {
      this.retrying = false;
      this.behind = { since: this.behind?.since ?? this.now(), reason, refused: true };
    }, this.deps.again?.());
  }

  private fellBehind(err: unknown): void {
    this.behind ??= { since: this.now(), reason: failureOf(err).reason };
  }

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  requests(ownerId: string, filter: { conversationId?: string | undefined; treeId?: string | undefined } = {}): Promise<EgressRequest[]> {
    return this.deps.store.getEgressRequests(ownerId, filter);
  }

  async grants(ownerId: string, agentSlug?: string): Promise<EgressGrantRecord[]> {
    return (await this.deps.store.getEgressGrants(ownerId)).filter((grant) => !grant.revokedAt && (!agentSlug || grant.agentSlug === agentSlug));
  }

  async syncProxy(): Promise<void> {
    await this.deps.proxy.sync(await this.deps.store.getEgressGrants());
    this.behind = undefined;
  }

  private async open(ownerId: string, id: string): Promise<{ opened: EgressRequest } | EgressDecision> {
    const request = await this.deps.store.getEgressRequest(ownerId, id);
    if (!request) return { ok: false, status: 404, error: 'Request not found' };
    if (request.status !== 'requested') return { ok: false, status: 409, error: `This request is already ${request.status}.` };
    return { opened: request };
  }

  async allow(ownerId: string, id: string): Promise<EgressDecision> {
    const found = await this.open(ownerId, id);
    if (!('opened' in found)) return found;
    const request = found.opened;
    const stamp = this.now();
    const grant: EgressGrantRecord = {
      id: this.deps.newId?.() ?? randomUUID(),
      ownerId,
      agentSlug: request.agentSlug,
      host: request.host,
      ...(request.ports ? { ports: request.ports } : {}),
      reason: request.why,
      approvedBy: ownerId,
      approvedAt: stamp,
    };
    await this.deps.store.saveEgressGrant(grant);
    try {
      await this.syncProxy();
    } catch (err) {
      await this.deps.store.saveEgressGrant({ ...grant, revokedAt: stamp, revokedBy: 'proxy-sync-failed' });
      return { ok: false, status: 502, error: `The proxy could not be updated, so nothing was granted: ${(err as Error).message}` };
    }
    const allowed: EgressRequest = { ...request, status: 'allowed', updatedAt: stamp };
    await this.deps.store.saveEgressRequest(allowed);
    return { ok: true, request: allowed, grant };
  }

  async dismiss(ownerId: string, id: string): Promise<EgressDecision> {
    const found = await this.open(ownerId, id);
    if (!('opened' in found)) return found;
    const dismissed: EgressRequest = { ...found.opened, status: 'dismissed', updatedAt: this.now() };
    await this.deps.store.saveEgressRequest(dismissed);
    return { ok: true, request: dismissed };
  }

  async revoke(ownerId: string, grantId: string): Promise<EgressDecision> {
    const grant = (await this.deps.store.getEgressGrants(ownerId)).find((entry) => entry.id === grantId);
    if (!grant) return { ok: false, status: 404, error: 'Grant not found' };
    if (grant.revokedAt) return { ok: false, status: 409, error: 'This grant is already revoked.' };
    const revoked: EgressGrantRecord = { ...grant, revokedAt: this.now(), revokedBy: ownerId };
    await this.deps.store.saveEgressGrant(revoked);
    try {
      await this.syncProxy();
    } catch (err) {
      this.fellBehind(err);
      void this.keepSynced();
      return { ok: false, status: 502, error: `Revoked, but the proxy could not be updated yet: ${(err as Error).message}` };
    }
    return { ok: true, grant: revoked };
  }
}
