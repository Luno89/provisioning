import type { Claim, RevocationReason } from '../../platform/index.js';
import { claimsShaped } from './oidc.js';

export interface ClientSession {
  id: string;
  ownerId: string;
  email: string;
  refreshToken: string;
  startedAt: string;
  expiresAt: string;
}

export interface LogoutDelivery {
  id: string;
  clientId: string;
  url: string;
  subject: string;
  revokedAt: string;
  why: RevocationReason;
  attempts?: number | undefined;
  lastError?: string | undefined;
  lastTriedAt?: string | undefined;
}

export interface SessionRevocation {
  subject: string;
  before: string;
}

export interface SignedInSession {
  userId: string;
  email: string;
  sid: string;
  sessionAt: number;
  freshUntil: number;
  claims: Claim[];
}

export function signedInSession(decoded: Record<string, unknown> | null | undefined): SignedInSession | undefined {
  if (!decoded) return undefined;
  const { userId, email, sid, sessionAt, freshUntil, claims } = decoded;
  if (typeof userId !== 'string' || !userId || typeof email !== 'string' || typeof sid !== 'string' || !sid) return undefined;
  if (typeof sessionAt !== 'number' || typeof freshUntil !== 'number' || !claimsShaped(claims)) return undefined;
  return { userId, email, sid, sessionAt, freshUntil, claims };
}

export const claimsStale = (session: SignedInSession, now: number): boolean => now >= session.freshUntil;

export class RevocationList {
  private readonly before = new Map<string, number>();

  load(revocations: readonly SessionRevocation[]): void {
    for (const revocation of revocations) this.revoke(revocation.subject, revocation.before);
  }

  revoke(subject: string, before: string): void {
    const at = Date.parse(before);
    if (Number.isNaN(at)) return;
    this.before.set(subject, Math.max(this.before.get(subject) ?? 0, at));
  }

  ended(session: Pick<SignedInSession, 'userId' | 'sessionAt'>): boolean {
    const before = this.before.get(session.userId);
    return before !== undefined && session.sessionAt < before;
  }
}
