import { createHash, timingSafeEqual } from 'node:crypto';

export const SIGN_UP_MINUTES = 30;
export const SIGN_UP_WRONG_CODES = 5;
export const SIGN_UP_CODES_SENT = 5;
export const EMAIL_LONGEST = 254;

export interface PendingSignUp {
  id: string;
  email: string;
  passwordHash: string;
  inviteHash: string;
  codeHash: string;
  wrong: number;
  sent: number;
  expiresAt: Date;
}

export const normalEmail = (email: unknown): string => (typeof email === 'string' ? email.trim().toLowerCase() : '');

export function emailProblem(email: string): string | undefined {
  const refused = 'That is not an email address; check it and try again';
  if (!email || email.length > EMAIL_LONGEST || /\s/.test(email)) return refused;
  const parts = email.split('@');
  if (parts.length !== 2) return refused;
  const [local, domain] = parts as [string, string];
  if (!local || !domain.includes('.')) return refused;
  if (domain.split('.').some((label) => !label)) return refused;
  return undefined;
}

export const signUpCodeHash = (id: string, code: string): string => createHash('sha256').update(`${id}:${code.trim()}`).digest('hex');

export function sameSignUpCode(pending: Pick<PendingSignUp, 'id' | 'codeHash'>, given: string): boolean {
  const expected = Buffer.from(pending.codeHash, 'hex');
  const offered = Buffer.from(signUpCodeHash(pending.id, given), 'hex');
  return expected.length === offered.length && timingSafeEqual(expected, offered);
}

export const signUpExpiry = (now: Date): Date => new Date(now.getTime() + SIGN_UP_MINUTES * 60_000);

export const signUpLive = (pending: Pick<PendingSignUp, 'expiresAt'> | undefined, now: Date): boolean =>
  pending !== undefined && pending.expiresAt.getTime() > now.getTime();

export const signUpCodeMail = (code: string): { subject: string; text: string } => ({
  subject: 'Your Koala sign-up code',
  text: `Your Koala sign-up code is ${code}. Enter it where you signed up; it works for ${SIGN_UP_MINUTES} minutes.\n\nIf you did not sign up for Koala, ignore this email and nothing happens.`,
});
