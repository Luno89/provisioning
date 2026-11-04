import { describe, expect, it } from 'vitest';
import { generateIdentityKey, identityKeysFrom, publicKeyPem, trustedKeys } from '../../instances/lib/identity-token.js';
import { checkWorkToken, issueWorkToken, workTokenRenewDue, WORK_TOKEN_RENEW_SECONDS, WORK_TOKEN_TTL_SECONDS } from './work-tokens.js';

const root = identityKeysFrom(generateIdentityKey());
const other = identityKeysFrom(generateIdentityKey());
const trusted = trustedKeys([publicKeyPem(root.publicKey)]);
const NOW = 1_800_000_000;
const machine = { machineId: 'm-1', ownerId: 'u-1', audience: 'inst-a' };

describe('a machine\'s work token', () => {
  it('names the machine, its owner and the Koala it is for, signed by root', () => {
    const check = checkWorkToken(issueWorkToken(root, machine, NOW), trusted, 'inst-a', NOW + 60);
    expect(check).toEqual({ ok: true, claims: { sub: 'm-1', owner: 'u-1', aud: 'inst-a', iat: NOW, exp: NOW + WORK_TOKEN_TTL_SECONDS } });
  });

  it('is refused by another Koala, when another key signed it, when changed, expired, or from the future', () => {
    const token = issueWorkToken(root, machine, NOW);
    expect(checkWorkToken(token, trusted, 'inst-b', NOW)).toEqual({ ok: false, reason: 'wrong-audience' });
    expect(checkWorkToken(issueWorkToken(other, machine, NOW), trusted, 'inst-a', NOW)).toEqual({ ok: false, reason: 'unknown-key' });
    const [head, , signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'm-2', owner: 'u-2', aud: 'inst-a', iat: NOW, exp: NOW + 60 })).toString('base64url');
    expect(checkWorkToken(`${head}.${forged}.${signature}`, trusted, 'inst-a', NOW)).toEqual({ ok: false, reason: 'bad-signature' });
    expect(checkWorkToken(token, trusted, 'inst-a', NOW + WORK_TOKEN_TTL_SECONDS)).toEqual({ ok: false, reason: 'expired' });
    expect(checkWorkToken(token, trusted, 'inst-a', NOW - 120)).toEqual({ ok: false, reason: 'not-yet-valid' });
    expect(checkWorkToken('not a token', trusted, 'inst-a', NOW)).toEqual({ ok: false, reason: 'malformed' });
    expect(checkWorkToken(undefined, trusted, 'inst-a', NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('is renewed once less than a week is left', () => {
    const exp = NOW + WORK_TOKEN_TTL_SECONDS;
    expect(workTokenRenewDue({ exp }, NOW)).toBe(false);
    expect(workTokenRenewDue({ exp }, exp - WORK_TOKEN_RENEW_SECONDS)).toBe(true);
  });
});
