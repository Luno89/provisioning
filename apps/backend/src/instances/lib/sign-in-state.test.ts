import { describe, expect, it } from 'vitest';
import { claimsStale, RevocationList, signedInSession } from './sign-in-state.js';

const session = { userId: 'u1', email: 'u1@example.com', sid: 's1', sessionAt: 1_000, freshUntil: 2_000, claims: [{ role: 'person' }] };

describe('a session an instance or the hub keeps for someone root signed in', () => {
  it('is read only whole, with claims it could have been issued', () => {
    expect(signedInSession(session)).toEqual(session);
    expect(signedInSession({ ...session, sid: '' })).toBeUndefined();
    expect(signedInSession({ ...session, claims: [{ role: 'root' }] })).toBeUndefined();
    expect(signedInSession({ userId: 'u1', email: 'e', sessionAt: 1 })).toBeUndefined();
    expect(signedInSession(null)).toBeUndefined();
  });

  it('asks root again once its claims are older than they are trusted for', () => {
    expect(claimsStale(signedInSession(session)!, 1_999)).toBe(false);
    expect(claimsStale(signedInSession(session)!, 2_000)).toBe(true);
  });

  it('ends every session begun before a revocation, keeps the latest revocation, and spares one begun after', () => {
    const revoked = new RevocationList();
    revoked.load([{ subject: 'u1', before: new Date(5_000).toISOString() }]);
    expect(revoked.ended({ userId: 'u1', sessionAt: 4_999 })).toBe(true);
    expect(revoked.ended({ userId: 'u1', sessionAt: 5_000 })).toBe(false);
    revoked.revoke('u1', new Date(3_000).toISOString());
    expect(revoked.ended({ userId: 'u1', sessionAt: 4_000 })).toBe(true);
    expect(revoked.ended({ userId: 'u2', sessionAt: 1 })).toBe(false);
  });
});
