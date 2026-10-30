import { handoffNonceShaped, type Database, type RoleConfig } from '../../platform/index.js';
import { issueHandoff, publicKeyPem } from '../lib/identity-token.js';
import { inService, instanceProblem, type InstanceRecord } from '../lib/instances.js';
import { handoffServedFor, START_PATH, startsSignInItself } from '../lib/oidc.js';
import { HUB_AUDIENCE } from '../../hub/lib/hub.js';
import { InstanceReach } from './InstanceReach.js';

type Store = Pick<Database, 'instances' | 'accounts'>;

export class IdentityService {
  constructor(
    private readonly role: RoleConfig,
    private readonly store: Store,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly signInAnswer: ((url: string) => Promise<unknown>) | undefined = undefined,
    private readonly reach: InstanceReach = new InstanceReach({ open: false }),
  ) {}

  private async startsSignIn(url: string, instance: InstanceRecord): Promise<boolean | undefined> {
    try {
      const answer = this.signInAnswer
        ? await this.signInAnswer(url)
        : await (await this.reach.fetchFor(instance)(`${url}/api/auth/sign-in`)).json();
      return startsSignInItself(answer);
    } catch {
      return undefined;
    }
  }

  publicKeys(): { kid: string; publicKey: string }[] {
    return this.role.signing ? [{ kid: this.role.signing.kid, publicKey: publicKeyPem(this.role.signing.publicKey) }] : [];
  }

  async instanceOf(ownerId: string): Promise<InstanceRecord | undefined> {
    return (await this.store.instances.getInstances(ownerId)).find((instance) => instance.url && inService(instance));
  }

  async goUrl(user: { id: string; email: string }, to?: { hub: true; next?: string | undefined }, nonce?: unknown): Promise<string | undefined> {
    if (!this.role.signing) return undefined;
    const bound = handoffNonceShaped(nonce) ? nonce : undefined;
    if (to?.hub) {
      if (!this.role.hubLink) return undefined;
      const going = to.next && /^\/[^/\\]/.test(to.next) ? to.next : undefined;
      if (await this.store.instances.getHubSignInKey()) return `${this.role.hubLink.url}${START_PATH}${going ? `?next=${encodeURIComponent(going)}` : ''}`;
      const token = issueHandoff(this.role.signing, { userId: user.id, email: user.email }, HUB_AUDIENCE, this.now(), bound);
      return `${this.role.hubLink.url}/#/handoff?token=${encodeURIComponent(token)}${going ? `&next=${encodeURIComponent(going)}` : ''}`;
    }
    const instance = await this.instanceOf(user.id);
    if (!instance) return undefined;
    const base = instance.url.replace(/\/+$/, '');
    if (!handoffServedFor(instance, instance.signIn ? await this.startsSignIn(base, instance) : undefined)) return `${base}${START_PATH}`;
    const token = issueHandoff(this.role.signing, { userId: user.id, email: user.email }, instance.id, this.now(), bound);
    return `${base}/#/handoff?token=${encodeURIComponent(token)}`;
  }

  hubUrl(): string | undefined {
    return this.role.instance ? `${this.role.instance.rootUrl}/api/identity/go?to=hub` : undefined;
  }

  removalUrl(): string | undefined {
    return this.role.instance ? `${this.role.instance.rootUrl}/#/remove-account` : undefined;
  }

  async register(candidate: { id: string; ownerId: string; url: string }): Promise<{ ok: true; instance: InstanceRecord } | { ok: false; error: string }> {
    const url = candidate.url.trim().replace(/\/+$/, '');
    const problem = instanceProblem({ ...candidate, url: `${url}/` });
    if (problem) return { ok: false, error: problem };
    const others = await this.store.instances.getInstances(candidate.ownerId);
    if (others.some((other) => other.id !== candidate.id)) return { ok: false, error: `${candidate.ownerId} already has an instance (${others[0]!.id})` };
    const now = new Date(this.now() * 1000).toISOString();
    const existing = others.find((other) => other.id === candidate.id);
    const instance: InstanceRecord = { id: candidate.id, ownerId: candidate.ownerId, url, createdAt: existing?.createdAt ?? now, updatedAt: now };
    await this.store.instances.saveInstance(instance);
    return { ok: true, instance };
  }
}
