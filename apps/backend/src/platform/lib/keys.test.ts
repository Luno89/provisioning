import { describe, it, expect } from 'vitest';
import { KEY_NAMES, MissingKeysError, loadKeys } from './keys.js';
import { decryptValue, encryptValue } from './crypto.js';

const full = {
  SESSION_KEY: 's'.repeat(64),
  DATA_KEY: 'd'.repeat(64),
  PAYLOAD_KEY: 'p'.repeat(64),
  EGRESS_KEY: 'e'.repeat(64),
};

describe('the platform keys', () => {
  it('refuses to run in production without all four, and names the missing ones', () => {
    expect(() => loadKeys({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(64) })).toThrow(MissingKeysError);
    expect(() => loadKeys({ NODE_ENV: 'production', ...full, EGRESS_KEY: 'too-short' })).toThrow(/EGRESS_KEY is not set, or shorter than 32/);
    expect(loadKeys({ NODE_ENV: 'production', ...full }).data.current).toBe(full.DATA_KEY);
  });

  it('never falls back to the key written in the source when in production', () => {
    const keys = loadKeys({ NODE_ENV: 'production', ...full });
    expect(keys.data.previous).toBeUndefined();
    expect(keys.session.previous).toBeUndefined();
  });

  it('gives each purpose its own key, even when dev derives them all from one secret', () => {
    const keys = loadKeys({ JWT_SECRET: 'one-dev-secret' });
    const all = [keys.session.current, keys.data.current, keys.payload.current, keys.egress];
    expect(new Set(all).size).toBe(4);
    expect(all).not.toContain('one-dev-secret');
    expect(Object.keys(KEY_NAMES)).toHaveLength(4);
  });

  it('still opens what the old single secret wrote, and what a derived key wrote before real keys were set', () => {
    const before = loadKeys({ JWT_SECRET: 'one-dev-secret' });
    const byOldSecret = encryptValue('stored long ago', 'one-dev-secret');
    const byDerivedKey = encryptValue('stored last week', before.data);

    const after = loadKeys({ JWT_SECRET: 'one-dev-secret', ...full });
    expect(decryptValue(byOldSecret, after.data)).toBe('stored long ago');
    expect(decryptValue(byDerivedKey, after.data)).toBe('stored last week');
    expect(after.data.current).toBe(full.DATA_KEY);
  });
});
