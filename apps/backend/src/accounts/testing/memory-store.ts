import { asStored } from '../../platform/testing/as-stored.js';
import type { InviteMetadata, UserMetadata } from '../../platform/index.js';
import { collectionIn, copied, keysWhere, MemoryRecords, ownedKeys, removeKeys, removeWhere, type Collections } from '../../platform/testing/memory-records.js';
import { inviteCodeHash } from '../../platform/lib/invite-codes.js';
import { ACCOUNT_DATA, type AccountIds, type AccountRelated } from '../lib/account-removal.js';
import type { InviteLimits } from '../lib/project-invite-limits.js';
import { RESET_CODES_SENT, type PasswordReset } from '../lib/password-reset.js';
import { linksFromLegacyIds, type LegacyProviderIds } from '../lib/provider-sign-in.js';
import type { TwoFactorCode } from '../lib/second-factor.js';
import { SIGN_UP_CODES_SENT, type PendingSignUp } from '../lib/sign-up.js';
import { FIRST_ADMIN_INVITE, type AccountsStore } from '../store.js';

const duplicateEmail = (): Error => Object.assign(new Error('E11000 duplicate key error: email'), { code: 11000 });

type Loose = Record<string, unknown>;

interface LegacyAdmin { isAdmin?: boolean }

export class MemoryAccountsStore implements AccountsStore {
  private readonly users: MemoryRecords<UserMetadata>;
  private readonly invites = new MemoryRecords<InviteMetadata>();
  private readonly pendingSignUps = new Map<string, Omit<PendingSignUp, 'id'>>();
  private readonly passwordResets: Map<string, Omit<PasswordReset, 'id'>>;
  private readonly twoFactorCodes: Map<string, Omit<TwoFactorCode, 'id'>>;
  private limits: InviteLimits | undefined;

  constructor(private readonly collections: Collections = new Map()) {
    this.users = new MemoryRecords(collectionIn<UserMetadata>(collections, 'users'));
    this.passwordResets = collectionIn<Omit<PasswordReset, 'id'>>(collections, 'passwordResets');
    this.twoFactorCodes = collectionIn<Omit<TwoFactorCode, 'id'>>(collections, 'twoFactorCodes');
  }

  async ensureIndexes(): Promise<void> {}

  private putUser(user: UserMetadata): void {
    if (this.users.all().some((other) => other.id !== user.id && other.email === user.email)) throw duplicateEmail();
    this.users.put(asStored(user));
  }

  private userWhere(match: (user: UserMetadata) => boolean): UserMetadata | undefined {
    return this.users.all().find(match);
  }

  async getUsers(): Promise<UserMetadata[]> {
    return this.users.all();
  }

  async saveUser(user: UserMetadata): Promise<void> {
    this.putUser(user);
  }

  async saveUserList(users: UserMetadata[]): Promise<void> {
    this.users.clear();
    for (const user of users) this.putUser(user);
  }

  async getUserByEmail(email: string): Promise<UserMetadata | undefined> {
    const wanted = email.trim().toLowerCase();
    return this.userWhere((user) => user.email === wanted);
  }

  async getUserBySignInLink(issuer: string, subject: string): Promise<UserMetadata | undefined> {
    return this.userWhere((user) => Array.isArray(user.signInLinks) && user.signInLinks.some((link) => link.issuer === issuer && link.subject === subject));
  }

  async getUserById(id: string): Promise<UserMetadata | undefined> {
    return this.users.get(id);
  }

  async deleteUser(id: string): Promise<void> {
    this.users.delete(id);
  }

  async grantOperatorToAdmins(): Promise<number> {
    let moved = 0;
    for (const user of this.users.all() as (UserMetadata & LegacyAdmin)[]) {
      if (!('isAdmin' in user)) continue;
      const admin = user.isAdmin === true;
      this.users.change(user.id, (stored) => {
        const { isAdmin: _admin, ...held } = stored as UserMetadata & LegacyAdmin;
        const roles = held.roles ?? [];
        return admin && !roles.includes('operator') ? { ...held, roles: [...roles, 'operator'] } : held;
      });
      if (admin) moved += 1;
    }
    return moved;
  }

  async moveProviderIdsToLinks(): Promise<number> {
    let moved = 0;
    for (const user of this.users.all()) {
      if (!('googleId' in user) && !('githubId' in user)) continue;
      this.users.change(user.id, (held) => {
        const next = { ...held, signInLinks: linksFromLegacyIds(held as UserMetadata & LegacyProviderIds) } as unknown as Loose;
        delete next.googleId;
        delete next.githubId;
        return next as unknown as UserMetadata;
      });
      moved += 1;
    }
    return moved;
  }

  async dropGitHubCredentials(): Promise<number> {
    let dropped = 0;
    for (const user of this.users.all()) {
      if (!user.credentials || !('github' in user.credentials)) continue;
      this.users.change(user.id, (held) => {
        const credentials = { ...held.credentials } as Loose;
        delete credentials.github;
        return { ...held, credentials } as unknown as UserMetadata;
      });
      dropped += 1;
    }
    return dropped;
  }

  private ids(name: string, ownerId: string): string[] {
    return ownedKeys(this.collections, name, ownerId);
  }

  private distinct(name: string, ownerId: string, field: string): string[] {
    const values = keysWhere(this.collections, name, (row) => row.ownerId === ownerId).map((key) => (this.collections.get(name)?.get(key) as Record<string, unknown>)[field]);
    return [...new Set(values.filter((value): value is string => typeof value === 'string'))];
  }

  async accountIds(ownerId: string): Promise<AccountIds> {
    const conversations = this.ids('conversations', ownerId);
    const live = conversations
      .map((id) => ((this.collections.get('conversations')?.get(id) as { liveTurn?: { runId?: unknown } }).liveTurn?.runId))
      .filter((id): id is string => typeof id === 'string');
    const projectIds = this.ids('projects', ownerId);
    return {
      runIds: [...new Set([...this.distinct('turnLogs', ownerId, 'turnId'), ...live])],
      treeIds: this.ids('trees', ownerId),
      conversationIds: conversations,
      proposalIds: this.ids('planProposals', ownerId),
      projectIds,
      buildWorkflowIds: keysWhere(this.collections, 'pipelineRuns', (row) => typeof row.projectId === 'string' && projectIds.includes(row.projectId) && (row.status === 'queued' || row.status === 'running'))
        .map((key) => (this.collections.get('pipelineRuns')?.get(key) as Record<string, unknown>).temporalWorkflowId)
        .filter((id): id is string => typeof id === 'string'),
      ingestIds: this.distinct('corpus', ownerId, 'ingestId'),
    };
  }

  async accountLeftovers(ownerId: string): Promise<Record<string, number>> {
    const left: Record<string, number> = {};
    const count = (name: string, found: number) => {
      if (found) left[name] = (left[name] ?? 0) + found;
    };
    for (const name of ACCOUNT_DATA.byOwner) count(name, this.ids(name, ownerId).length);
    for (const name of [...ACCOUNT_DATA.byId, ACCOUNT_DATA.last]) count(name, this.collections.get(name)?.has(ownerId) ? 1 : 0);
    return left;
  }

  async removeAccountRecords(ownerId: string, related: AccountRelated): Promise<Record<string, number>> {
    const removed: Record<string, number> = {};
    const count = (name: string, deleted: number) => {
      if (deleted) removed[name] = (removed[name] ?? 0) + deleted;
    };
    const inList = (list: readonly string[], value: unknown): boolean => typeof value === 'string' && list.includes(value);
    if (related.watermarkKeys.length) count('memoryWatermarks', removeKeys(this.collections, 'memoryWatermarks', related.watermarkKeys));
    if (related.ingestIds.length) count('crawl_frontier', removeWhere(this.collections, 'crawl_frontier', (row) => inList(related.ingestIds, row.ingestId)));
    if (related.projectIds.length) count('pipelineRuns', removeWhere(this.collections, 'pipelineRuns', (row) => inList(related.projectIds, row.projectId)));
    if (related.projectIds.length) count('hubSnapshots', removeWhere(this.collections, 'hubSnapshots', (row) => inList(related.projectIds, row.projectId)));
    count('oidcArtifacts', removeWhere(this.collections, 'oidcArtifacts', (row) => row.accountId === ownerId));
    for (const name of ACCOUNT_DATA.byOwner) count(name, removeKeys(this.collections, name, this.ids(name, ownerId)));
    for (const name of ACCOUNT_DATA.byId) count(name, removeKeys(this.collections, name, [ownerId]));
    count(ACCOUNT_DATA.last, removeKeys(this.collections, ACCOUNT_DATA.last, [ownerId]));
    return removed;
  }

  private ownedBy(name: string, ownerId: string): string[] {
    return this.ids(name, ownerId);
  }

  async getInvites(): Promise<InviteMetadata[]> {
    return this.invites.all();
  }

  async getInviteByCode(code: string): Promise<InviteMetadata | undefined> {
    return this.getInviteByHash(inviteCodeHash(code));
  }

  async getInviteByHash(codeHash: string): Promise<InviteMetadata | undefined> {
    return this.invites.all().find((invite) => invite.codeHash === codeHash);
  }

  async claimInvite(code: string, usedBy: string, usedAt: string): Promise<boolean> {
    return this.claimInviteByHash(inviteCodeHash(code), usedBy, usedAt);
  }

  async claimInviteByHash(codeHash: string, usedBy: string, usedAt: string): Promise<boolean> {
    const open = this.invites.all().find((invite) => invite.codeHash === codeHash && !('usedBy' in invite));
    if (!open) return false;
    return this.invites.change(open.id, (invite) => ({ ...invite, usedBy, usedAt }));
  }

  async claimFirstAdmin(userId: string, at: string): Promise<boolean> {
    if (this.invites.get(FIRST_ADMIN_INVITE)) return false;
    this.invites.put({ id: FIRST_ADMIN_INVITE, createdBy: 'setup', createdAt: at, usedBy: userId, usedAt: at });
    return true;
  }

  async saveInvite(invite: InviteMetadata): Promise<void> {
    this.invites.put(asStored(invite));
  }

  async hashInviteCodes(expiresAt: string): Promise<number> {
    let hashed = 0;
    for (const invite of this.invites.all()) {
      if (typeof invite.code !== 'string') continue;
      const used = Boolean(invite.usedBy);
      this.invites.change(invite.id, (held) => {
        const { code, ...rest } = held;
        return { ...rest, codeHash: inviteCodeHash(String(code)), ...(used || held.expiresAt ? {} : { expiresAt }) };
      });
      hashed += 1;
    }
    return hashed;
  }

  async getInviteLimits(): Promise<Partial<InviteLimits> | undefined> {
    return this.limits ? copied(this.limits) : undefined;
  }

  async saveInviteLimits(limits: InviteLimits): Promise<void> {
    this.limits = { accounts: limits.accounts, perHour: limits.perHour };
  }

  async savePendingSignUp(pending: PendingSignUp): Promise<void> {
    const { id, ...rest } = pending;
    this.pendingSignUps.set(id, asStored(copied(rest)));
  }

  async getPendingSignUp(id: string): Promise<PendingSignUp | undefined> {
    const held = this.pendingSignUps.get(id);
    return held ? { id, ...copied(held) } : undefined;
  }

  async wrongSignUpCode(id: string): Promise<number> {
    return this.bump(this.pendingSignUps.get(id));
  }

  async newSignUpCode(id: string, codeHash: string, expiresAt: Date): Promise<boolean> {
    return this.resend(this.pendingSignUps.get(id), SIGN_UP_CODES_SENT, codeHash, expiresAt);
  }

  async deletePendingSignUp(id: string): Promise<boolean> {
    return this.pendingSignUps.delete(id);
  }

  async savePasswordReset(reset: PasswordReset): Promise<void> {
    const { id, ...rest } = reset;
    this.passwordResets.set(id, asStored(copied(rest)));
  }

  async getPasswordReset(id: string): Promise<PasswordReset | undefined> {
    const held = this.passwordResets.get(id);
    return held ? { id, ...copied(held) } : undefined;
  }

  async wrongResetCode(id: string): Promise<number> {
    return this.bump(this.passwordResets.get(id));
  }

  async newResetCode(id: string, codeHash: string, expiresAt: Date): Promise<boolean> {
    return this.resend(this.passwordResets.get(id), RESET_CODES_SENT, codeHash, expiresAt);
  }

  async deletePasswordReset(id: string): Promise<boolean> {
    return this.passwordResets.delete(id);
  }

  async saveTwoFactorCode(code: TwoFactorCode): Promise<void> {
    const { id, ...rest } = code;
    this.twoFactorCodes.set(id, copied(rest));
  }

  async getTwoFactorCode(id: string): Promise<TwoFactorCode | undefined> {
    const held = this.twoFactorCodes.get(id);
    return held ? { id, ownerId: String(held.ownerId), codeHash: String(held.codeHash), expiresAt: copied(held.expiresAt) } : undefined;
  }

  async takeTwoFactorCode(id: string): Promise<boolean> {
    return this.twoFactorCodes.delete(id);
  }

  async dropTwoFactorCodesOf(ownerId: string): Promise<void> {
    for (const id of this.ownedBy('twoFactorCodes', ownerId)) this.twoFactorCodes.delete(id);
  }

  private bump(held: { wrong: number } | undefined): number {
    if (!held) return Number.POSITIVE_INFINITY;
    held.wrong += 1;
    return held.wrong;
  }

  private resend(held: { sent: number; codeHash: string; expiresAt: Date } | undefined, most: number, codeHash: string, expiresAt: Date): boolean {
    if (!held || !(held.sent < most)) return false;
    held.codeHash = codeHash;
    held.expiresAt = copied(expiresAt);
    held.sent += 1;
    return true;
  }
}
