import { describe, expect, it } from 'vitest';
import { revocationShaped, type AccessRevoked } from './revocations.js';

describe('a person\'s access taken away', () => {
  const event: AccessRevoked = { personId: 'u1', because: 'signed-out-everywhere', at: '2026-10-29T00:00:00.000Z' };

  it('is read from elsewhere only when it names a person, a time and a reason Koala gives', () => {
    expect(revocationShaped(event)).toBe(true);
    expect(revocationShaped({ ...event, because: 'account-removed' })).toBe(true);
    expect(revocationShaped({ ...event, because: 'removed-from-shared-project' })).toBe(false);
    expect(revocationShaped({ ...event, because: 'bored' })).toBe(false);
    expect(revocationShaped({ ...event, because: 'locked' })).toBe(false);
    expect(revocationShaped({ ...event, at: 'yesterday' })).toBe(false);
    expect(revocationShaped({ ...event, personId: '' })).toBe(false);
  });
});
