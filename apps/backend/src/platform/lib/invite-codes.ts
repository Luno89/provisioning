import { createHash, randomBytes } from 'node:crypto';
import type { InviteMetadata } from './types.js';

export const INVITE_DAYS = 14;

export const newInviteCode = (): string => randomBytes(16).toString('base64url');

export const inviteCodeHash = (code: string): string => createHash('sha256').update(code).digest('hex');

export const inviteExpiry = (now: Date): string => new Date(now.getTime() + INVITE_DAYS * 24 * 60 * 60 * 1000).toISOString();

export const inviteExpired = (invite: Pick<InviteMetadata, 'expiresAt'>, now: Date): boolean =>
  invite.expiresAt !== undefined && Date.parse(invite.expiresAt) <= now.getTime();

export type InviteView = Omit<InviteMetadata, 'code' | 'codeHash'> & { expired: boolean };

export const inviteView = ({ code: _code, codeHash: _hash, ...invite }: InviteMetadata, now: Date): InviteView =>
  ({ ...invite, expired: !invite.usedBy && inviteExpired(invite, now) });
