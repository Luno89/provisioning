import { describe, expect, it } from 'vitest';
import { AccessRevocations, revocationShaped, type AccessRevoked } from './access-revocation.js';

describe('a person\'s access taken away', () => {
  it('is told to every listener in turn, each finishing before the next', async () => {
    const heard: string[] = [];
    const revocations = new AccessRevocations();
    revocations.on(async (event) => { await new Promise((resolve) => setTimeout(resolve, 5)); heard.push(`first ${event.subject}`); });
    revocations.on((event) => { heard.push(`second ${event.why}`); });
    await revocations.revoked({ subject: 'u1', at: '2026-10-29T00:00:00.000Z', why: 'account-removed' });
    expect(heard).toEqual(['first u1', 'second account-removed']);
  });

  it('is read from elsewhere only when it names a person, a time and a reason Koala gives', () => {
    const event: AccessRevoked = { subject: 'u1', at: '2026-10-29T00:00:00.000Z', why: 'signed-out-everywhere' };
    expect(revocationShaped(event)).toBe(true);
    expect(revocationShaped({ ...event, why: 'bored' })).toBe(false);
    expect(revocationShaped({ ...event, at: 'yesterday' })).toBe(false);
    expect(revocationShaped({ ...event, subject: '' })).toBe(false);
  });
});
