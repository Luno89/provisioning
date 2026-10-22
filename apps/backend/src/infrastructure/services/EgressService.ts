import { randomUUID } from 'node:crypto';
import type { EgressGrantRecord, EgressRequest } from '@koala/harness-types';

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

export class EgressService {
  constructor(private readonly deps: { store: EgressStore; proxy: EgressProxy; now?: () => string; newId?: () => string }) {}

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
      return { ok: false, status: 502, error: `Revoked, but the proxy could not be updated yet: ${(err as Error).message}` };
    }
    return { ok: true, grant: revoked };
  }
}
