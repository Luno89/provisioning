import { createHash, timingSafeEqual } from 'node:crypto';

export type CodePurpose = 'sign-in' | 'confirm';

export const TWO_FACTOR_MINUTES = 5;

export interface TwoFactorCode {
  id: string;
  ownerId: string;
  codeHash: string;
  expiresAt: Date;
}

export const twoFactorCodeId = (userId: string, purpose: CodePurpose): string => `${purpose}:${userId}`;

export const twoFactorCodeHash = (id: string, code: string): string => createHash('sha256').update(`${id}:${code.trim()}`).digest('hex');

export function sameTwoFactorCode(held: Pick<TwoFactorCode, 'id' | 'codeHash'>, given: string): boolean {
  const expected = Buffer.from(held.codeHash, 'hex');
  const offered = Buffer.from(twoFactorCodeHash(held.id, given), 'hex');
  return expected.length === offered.length && timingSafeEqual(expected, offered);
}

export const twoFactorExpiry = (now: number): Date => new Date(now + TWO_FACTOR_MINUTES * 60_000);

export const twoFactorLive = (held: Pick<TwoFactorCode, 'expiresAt'> | undefined, now: number): held is TwoFactorCode =>
  held !== undefined && held.expiresAt.getTime() > now;

export type ConfirmWith = 'two-factor' | 'password' | 'email-code';

export const confirmWith = (user: { twoFactorEnabled?: boolean | undefined; passwordHash?: string | undefined }): ConfirmWith =>
  user.twoFactorEnabled ? 'two-factor' : user.passwordHash ? 'password' : 'email-code';

export interface Proof {
  password?: string | undefined;
  code?: string | undefined;
}

export function proofFrom(body: unknown): Proof {
  const given = (body ?? {}) as Record<string, unknown>;
  return {
    ...(typeof given.password === 'string' && given.password ? { password: given.password } : {}),
    ...(typeof given.code === 'string' && given.code.trim() ? { code: given.code.trim() } : {}),
  };
}

export interface TwoFactorChange {
  enabled: boolean;
  phone?: string | undefined;
  preferredMethod?: 'email' | 'sms' | undefined;
}

export function twoFactorChangeFrom(body: unknown): TwoFactorChange | { problem: string } {
  const given = (body ?? {}) as Record<string, unknown>;
  if (given.phone !== undefined && typeof given.phone !== 'string') return { problem: 'The phone number for sign-in codes must be text' };
  if (given.preferredMethod !== undefined && given.preferredMethod !== 'email' && given.preferredMethod !== 'sms') return { problem: 'Sign-in codes go by email or by SMS' };
  return {
    enabled: Boolean(given.enabled),
    ...(given.phone !== undefined ? { phone: given.phone } : {}),
    ...(given.preferredMethod !== undefined ? { preferredMethod: given.preferredMethod } : {}),
  };
}

export const PROOF_ASKED: Readonly<Record<ConfirmWith, string>> = {
  'two-factor': 'Enter a current code from your two-factor sign-in to do this',
  password: 'Enter your password to do this',
  'email-code': 'Enter the code we email you to do this',
};

export interface PasswordChangeNeeds {
  current: boolean;
  code: boolean;
}

export const passwordChangeNeeds = (user: { twoFactorEnabled?: boolean | undefined; passwordHash?: string | undefined }): PasswordChangeNeeds =>
  ({ current: Boolean(user.passwordHash), code: Boolean(user.twoFactorEnabled) || !user.passwordHash });

export const confirmCodeMail = (code: string): { subject: string; text: string } => ({
  subject: 'Your Koala confirmation code',
  text: `Your Koala confirmation code is ${code}. It works for ${TWO_FACTOR_MINUTES} minutes, for the change you asked to make in your account settings.\n\nIf you did not ask, someone may be signed in as you: sign out everywhere and change your password.`,
});

export const signInCodeMail = (code: string): { subject: string; text: string } => ({
  subject: 'Your Koala sign-in code',
  text: `Your Koala sign-in code is ${code}. It works for ${TWO_FACTOR_MINUTES} minutes.`,
});
