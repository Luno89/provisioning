import crypto from 'crypto';
import type { Database, RoleConfig } from '../../platform/index.js';
import { publicKeyPem } from '../lib/identity-token.js';
import { inService, instanceProblem, type InstanceRecord } from '../lib/instances.js';
import { SIGN_IN_KEY_NOT_NAMED, signInWaitingFor, START_PATH } from '../lib/oidc.js';
import { hashCredential } from './InstanceService.js';

type Store = Pick<Database, 'instances' | 'accounts'>;

export type GoTo = { url: string } | { waiting: string };

export class IdentityService {
  constructor(
    private readonly role: RoleConfig,
    private readonly store: Store,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  publicKeys(): { kid: string; publicKey: string }[] {
    return this.role.signing ? [{ kid: this.role.signing.kid, publicKey: publicKeyPem(this.role.signing.publicKey) }] : [];
  }

  async instanceOf(ownerId: string): Promise<InstanceRecord | undefined> {
    return (await this.store.instances.getInstances(ownerId)).find((instance) => instance.url && inService(instance));
  }

  async goUrl(user: { id: string; email: string }, to?: { hub: true; next?: string | undefined }): Promise<GoTo | undefined> {
    if (!this.role.signing) return undefined;
    if (to?.hub) {
      if (!this.role.hubLink) return undefined;
      if (!(await this.store.instances.getHubSignInKey())) return { waiting: SIGN_IN_KEY_NOT_NAMED.hub };
      const going = to.next && /^\/[^/\\]/.test(to.next) ? to.next : undefined;
      return { url: `${this.role.hubLink.url}${START_PATH}${going ? `?next=${encodeURIComponent(going)}` : ''}` };
    }
    const instance = await this.instanceOf(user.id);
    if (!instance) return undefined;
    const waiting = signInWaitingFor(instance);
    return waiting ? { waiting } : { url: `${instance.url.replace(/\/+$/, '')}${START_PATH}` };
  }

  hubUrl(): string | undefined {
    return this.role.instance ? `${this.role.instance.rootUrl}/api/identity/go?to=hub` : undefined;
  }

  removalUrl(): string | undefined {
    return this.role.instance ? `${this.role.instance.rootUrl}/#/remove-account` : undefined;
  }

  async register(candidate: { id: string; ownerId: string; url: string }): Promise<{ ok: true; instance: InstanceRecord; credential: string } | { ok: false; error: string }> {
    const url = candidate.url.trim().replace(/\/+$/, '');
    const problem = instanceProblem({ ...candidate, url: `${url}/` });
    if (problem) return { ok: false, error: problem };
    const others = await this.store.instances.getInstances(candidate.ownerId);
    if (others.some((other) => other.id !== candidate.id)) return { ok: false, error: `${candidate.ownerId} already has an instance (${others[0]!.id})` };
    const now = new Date(this.now() * 1000).toISOString();
    const existing = others.find((other) => other.id === candidate.id);
    const credential = crypto.randomBytes(32).toString('base64url');
    const instance: InstanceRecord = { id: candidate.id, ownerId: candidate.ownerId, url, credentialHash: hashCredential(credential), createdAt: existing?.createdAt ?? now, updatedAt: now };
    await this.store.instances.saveInstance(instance);
    return { ok: true, instance, credential };
  }
}
