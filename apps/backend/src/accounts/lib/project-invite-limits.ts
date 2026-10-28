import { inviteExpired } from '../../platform/lib/invite-codes.js';
import type { InviteMetadata } from '../../platform/index.js';

export interface InviteLimits {
  accounts: number;
  perHour: number;
}

export const DEFAULT_INVITE_LIMITS: InviteLimits = { accounts: 10, perHour: 20 };

const HOUR_MS = 60 * 60 * 1000;

export const limitsProblem = (input: { accounts?: unknown; perHour?: unknown }): string | undefined => {
  const whole = (value: unknown, least: number) => typeof value === 'number' && Number.isInteger(value) && value >= least && value <= 10_000;
  if (input.accounts !== undefined && !whole(input.accounts, 0)) return 'the accounts a person\'s invites may make is a whole number from 0';
  if (input.perHour !== undefined && !whole(input.perHour, 1)) return 'the invites a person may send an hour is a whole number from 1';
  return undefined;
};

export function accountsMadeBy(invites: readonly InviteMetadata[], inviterId: string, now: Date): number {
  return invites.filter((invite) => invite.createdBy === inviterId && invite.project && invite.makesAccount && (invite.usedBy || !inviteExpired(invite, now))).length;
}

export function projectInviteRefusal(
  invites: readonly InviteMetadata[],
  inviter: { id: string; operator: boolean; inviteAccounts?: number | undefined },
  limits: InviteLimits,
  makesAccount: boolean,
  now: Date,
): string | undefined {
  if (inviter.operator) return undefined;
  const sent = invites.filter((invite) => invite.createdBy === inviter.id && invite.project && now.getTime() - Date.parse(invite.createdAt) < HOUR_MS)
    .map((invite) => Date.parse(invite.createdAt)).sort((a, b) => a - b);
  if (sent.length >= limits.perHour) {
    const minutes = Math.max(1, Math.ceil((sent[sent.length - limits.perHour]! + HOUR_MS - now.getTime()) / 60_000));
    return `You have sent ${sent.length} project invites in the last hour, the most an hour allows; try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
  }
  if (!makesAccount) return undefined;
  const allowed = inviter.inviteAccounts ?? limits.accounts;
  const made = accountsMadeBy(invites, inviter.id, now);
  if (made >= allowed) {
    return `Your project invites have brought ${made} new ${made === 1 ? 'person' : 'people'} to Koala, as many as you may (${allowed}); an admin can raise it, or invite someone who already has an account.`;
  }
  return undefined;
}
