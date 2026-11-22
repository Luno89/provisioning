import { describe, expect, it } from 'vitest';
import { workTokenExpiry } from './machine-token.js';

describe('workTokenExpiry', () => {
  const token = (claims: unknown) => `head.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

  it('reads when a work token from root runs out, so the agent asks for the next before then', () => {
    expect(workTokenExpiry(token({ sub: 'm', exp: 1_800_000_000 }))).toBe(1_800_000_000);
  });

  it('reads nothing from a token without an expiry or that is not one', () => {
    expect(workTokenExpiry(token({ sub: 'm' }))).toBeUndefined();
    expect(workTokenExpiry('not-a-token')).toBeUndefined();
    expect(workTokenExpiry('a.%%%.c')).toBeUndefined();
  });
});
