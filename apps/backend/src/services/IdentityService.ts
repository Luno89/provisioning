import type { Database } from '../lib/db-interface.js';
import { checkHandoff, issueHandoff, publicKeyPem, type HandoffCheck } from '../lib/identity-token.js';
import { instanceProblem, type InstanceRecord } from '../lib/instances.js';
import type { RoleConfig } from '../lib/platform-role.js';

type Store = Pick<Database, 'claimHandoff' | 'getInstances' | 'saveInstance' | 'deleteInstance' | 'getUserById' | 'saveUser'>;

export type HandoffOutcome =
  | { ok: true; user: { id: string; email: string } }
  | { ok: false; status: 400 | 401 | 403 | 409; error: string };

const REFUSALS: Record<Exclude<HandoffCheck, { ok: true }>['reason'], string> = {
  malformed: 'that is not a sign-in token',
  'unknown-key': 'that sign-in token was not signed by a root this instance trusts',
  'bad-signature': 'that sign-in token was changed after it was signed',
  'wrong-audience': 'that sign-in token is for a different instance',
  expired: 'that sign-in token has expired — sign in again',
  'not-yet-valid': 'that sign-in token is not valid yet — check this machine\'s clock',
};

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
    return (await this.store.getInstances(ownerId)).find((instance) => instance.url && (instance.status === undefined || instance.status === 'ready'));
  }

  async handoffUrl(user: { id: string; email: string }): Promise<string | undefined> {
    if (!this.role.signing) return undefined;
    const instance = await this.instanceOf(user.id);
    if (!instance) return undefined;
    const token = issueHandoff(this.role.signing, { userId: user.id, email: user.email }, instance.id, this.now());
    return `${instance.url.replace(/\/+$/, '')}/#/handoff?token=${encodeURIComponent(token)}`;
  }

  signInUrl(): string | undefined {
    return this.role.instance ? `${this.role.instance.rootUrl}/api/identity/go` : undefined;
  }

  async acceptHandoff(token: unknown): Promise<HandoffOutcome> {
    const instance = this.role.instance;
    if (!instance || !this.role.trusted) return { ok: false, status: 400, error: 'this server is not an instance, so it takes no sign-in tokens' };
    if (typeof token !== 'string') return { ok: false, status: 400, error: 'send the sign-in token as "token"' };

    const check = checkHandoff(token, this.role.trusted, instance.id, this.now());
    if (!check.ok) return { ok: false, status: 401, error: REFUSALS[check.reason] };
    if (check.claims.sub !== instance.ownerId) return { ok: false, status: 403, error: 'this instance belongs to someone else' };
    if (!await this.store.claimHandoff(check.claims.jti, new Date(check.claims.exp * 1000).toISOString())) {
      return { ok: false, status: 409, error: 'that sign-in token has already been used — sign in again' };
    }

    const existing = await this.store.getUserById(check.claims.sub);
    await this.store.saveUser({
      ...(existing ?? { twoFactorEnabled: false, createdAt: new Date(this.now() * 1000).toISOString() }),
      id: check.claims.sub,
      email: check.claims.email,
      emailVerified: true,
      isAdmin: true,
    } as never);
    return { ok: true, user: { id: check.claims.sub, email: check.claims.email } };
  }

  async register(candidate: { id: string; ownerId: string; url: string }): Promise<{ ok: true; instance: InstanceRecord } | { ok: false; error: string }> {
    const url = candidate.url.trim().replace(/\/+$/, '');
    const problem = instanceProblem({ ...candidate, url: `${url}/` });
    if (problem) return { ok: false, error: problem };
    const others = await this.store.getInstances(candidate.ownerId);
    if (others.some((other) => other.id !== candidate.id)) return { ok: false, error: `${candidate.ownerId} already has an instance (${others[0]!.id})` };
    const now = new Date(this.now() * 1000).toISOString();
    const existing = others.find((other) => other.id === candidate.id);
    const instance: InstanceRecord = { id: candidate.id, ownerId: candidate.ownerId, url, createdAt: existing?.createdAt ?? now, updatedAt: now };
    await this.store.saveInstance(instance);
    return { ok: true, instance };
  }
}
