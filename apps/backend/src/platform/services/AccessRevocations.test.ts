import { describe, expect, it } from 'vitest';
import { AccessRevocations } from './AccessRevocations.js';

describe('the one place a revocation is told', () => {
  it('reaches every listener, even when one of them fails', async () => {
    const heard: string[] = [];
    const revocations = new AccessRevocations();
    revocations.listen(async () => { throw new Error('the engine is restarting'); });
    revocations.listen(async (revoked) => { heard.push(`${revoked.personId} ${revoked.because}`); });
    await revocations.revoked({ personId: 'u1', because: 'account-removed', at: '2026-10-29T00:00:00.000Z' });
    expect(heard).toEqual(['u1 account-removed']);
  });
});
