import type { InviteMetadata, UserMetadata } from '../../platform/index.js';
import { accountsMadeBy, DEFAULT_INVITE_LIMITS, limitsProblem, type InviteLimits } from '../lib/project-invite-limits.js';

export interface ProjectInviteLimitsStore {
  getUsers(): Promise<UserMetadata[]>;
  getUserById(id: string): Promise<UserMetadata | undefined>;
  saveUser(user: UserMetadata): Promise<void>;
  getInvites(): Promise<InviteMetadata[]>;
  getInviteLimits(): Promise<Partial<InviteLimits> | undefined>;
  saveInviteLimits(limits: InviteLimits): Promise<void>;
}

export interface ProjectInvitePerson {
  id: string;
  email: string;
  made: number;
  own?: number | undefined;
}

export type LimitsOutcome<T> = { ok: true; value: T } | { ok: false; status: 400 | 404; why: string };

export class ProjectInviteLimitsService {
  constructor(private readonly deps: { store: ProjectInviteLimitsStore; now?: (() => Date) | undefined }) {}

  async limits(): Promise<InviteLimits> {
    return { ...DEFAULT_INVITE_LIMITS, ...(await this.deps.store.getInviteLimits()) };
  }

  async overview(): Promise<InviteLimits & { people: ProjectInvitePerson[] }> {
    const [limits, users, invites] = await Promise.all([this.limits(), this.deps.store.getUsers(), this.deps.store.getInvites()]);
    const now = this.deps.now?.() ?? new Date();
    const people = users.filter((user) => !user.space && !user.isAdmin).map((user) => ({
      id: user.id,
      email: user.email,
      made: accountsMadeBy(invites, user.id, now),
      ...(user.inviteAccounts !== undefined ? { own: user.inviteAccounts } : {}),
    }));
    return { ...limits, people };
  }

  async setLimits(input: { accounts?: unknown; perHour?: unknown }): Promise<LimitsOutcome<InviteLimits>> {
    const problem = limitsProblem(input);
    if (problem) return { ok: false, status: 400, why: problem };
    const next = { ...(await this.limits()), ...(input.accounts !== undefined ? { accounts: input.accounts as number } : {}), ...(input.perHour !== undefined ? { perHour: input.perHour as number } : {}) };
    await this.deps.store.saveInviteLimits(next);
    return { ok: true, value: next };
  }

  async setOwn(personId: string, accounts: unknown): Promise<LimitsOutcome<ProjectInvitePerson>> {
    if (accounts === undefined) return { ok: false, status: 400, why: 'give the accounts this person\'s invites may make, or null to use the default' };
    if (accounts !== null) {
      const problem = limitsProblem({ accounts });
      if (problem) return { ok: false, status: 400, why: problem };
    }
    const user = await this.deps.store.getUserById(personId);
    if (!user || user.space) return { ok: false, status: 404, why: 'There is no such account' };
    const { inviteAccounts: _old, ...rest } = user;
    const saved: UserMetadata = accounts === null ? rest : { ...rest, inviteAccounts: accounts as number };
    await this.deps.store.saveUser(saved);
    const made = accountsMadeBy(await this.deps.store.getInvites(), user.id, this.deps.now?.() ?? new Date());
    return { ok: true, value: { id: user.id, email: user.email, made, ...(saved.inviteAccounts !== undefined ? { own: saved.inviteAccounts } : {}) } };
  }
}
