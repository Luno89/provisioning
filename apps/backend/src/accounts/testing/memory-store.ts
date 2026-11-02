import { asStored } from '../../platform/testing/as-stored.js';
import type { InviteMetadata, UserMetadata } from '../../platform/index.js';
import { copied, MemoryRecords } from '../../platform/testing/memory-records.js';
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
  private readonly users = new MemoryRecords<UserMetadata>();
  private readonly invites = new MemoryRecords<InviteMetadata>();
  private readonly pendingSignUps = new Map<string, Omit<PendingSignUp, 'id'>>();
  private readonly passwordResets = new Map<string, Omit<PasswordReset, 'id'>>();
  private readonly twoFactorCodes = new Map<string, Omit<TwoFactorCode, 'id'>>();
  private limits: InviteLimits | undefined;

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

  async accountIds(): Promise<AccountIds> {
    return { runIds: [], treeIds: [], conversationIds: [], proposalIds: [], projectIds: [], buildWorkflowIds: [], ingestIds: [] };
  }

  async accountLeftovers(ownerId: string): Promise<Record<string, number>> {
    const left: Record<string, number> = {};
    const count = (name: string, found: number) => {
      if (found) left[name] = (left[name] ?? 0) + found;
    };
    for (const name of ACCOUNT_DATA.byOwner) count(name, this.ownedBy(name, ownerId).length);
    count(ACCOUNT_DATA.last, this.users.get(ownerId) ? 1 : 0);
    return left;
  }

  async removeAccountRecords(ownerId: string, _related: AccountRelated): Promise<Record<string, number>> {
    const removed: Record<string, number> = {};
    for (const name of ACCOUNT_DATA.byOwner) {
      const ids = this.ownedBy(name, ownerId);
      if (ids.length === 0) continue;
      for (const id of ids) this.owned(name)?.delete(id);
      removed[name] = ids.length;
    }
    if (this.users.delete(ownerId)) removed[ACCOUNT_DATA.last] = 1;
    return removed;
  }

  private owned(name: string): Map<string, { ownerId?: string | undefined }> | undefined {
    if (name === 'passwordResets') return this.passwordResets;
    if (name === 'twoFactorCodes') return this.twoFactorCodes;
    return undefined;
  }

  private ownedBy(name: string, ownerId: string): string[] {
    const rows = this.owned(name);
    return rows ? [...rows].filter(([, row]) => row.ownerId === ownerId).map(([id]) => id) : [];
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
