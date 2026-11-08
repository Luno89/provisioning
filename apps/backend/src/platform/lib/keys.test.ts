import { describe, it, expect } from 'vitest';
import { KEY_NAMES, MissingKeysError, loadKey, loadKeys } from './keys.js';

const full = {
  SESSION_KEY: 's'.repeat(64),
  DATA_KEY: 'd'.repeat(64),
  PAYLOAD_KEY: 'p'.repeat(64),
  EGRESS_KEY: 'e'.repeat(64),
  TEMPORAL_KEY: 't'.repeat(64),
};

describe('the platform keys', () => {
  it('refuses to run without all five, in production or not, and names the missing ones', () => {
    for (const mode of [{ NODE_ENV: 'production' }, {}]) {
      expect(() => loadKeys({ ...mode })).toThrow(MissingKeysError);
      expect(() => loadKeys({ ...mode, ...full, EGRESS_KEY: 'too-short' })).toThrow(/^EGRESS_KEY is not set, or shorter than 32/);
      expect(() => loadKeys({ ...mode, ...full, TEMPORAL_KEY: undefined })).toThrow(/^TEMPORAL_KEY is not set/);
      expect(() => loadKeys({ ...mode, DATA_KEY: full.DATA_KEY })).toThrow(/^SESSION_KEY, PAYLOAD_KEY, EGRESS_KEY, TEMPORAL_KEY are not set/);
      expect(loadKeys({ ...mode, ...full }).data.current).toBe(full.DATA_KEY);
    }
  });

  it('makes no key from JWT_SECRET or from anything written in the source, and keeps no previous key', () => {
    expect(() => loadKeys({ JWT_SECRET: 'x'.repeat(64) })).toThrow(MissingKeysError);
    const keys = loadKeys({ ...full, JWT_SECRET: 'x'.repeat(64) });
    expect(keys).toEqual({ session: { current: full.SESSION_KEY }, data: { current: full.DATA_KEY }, payload: { current: full.PAYLOAD_KEY }, egress: full.EGRESS_KEY, temporal: full.TEMPORAL_KEY });
    expect(Object.keys(KEY_NAMES)).toHaveLength(5);
  });

  it('gives a program that needs one key, such as Temporal\'s key server, that key alone', () => {
    expect(loadKey({ TEMPORAL_KEY: full.TEMPORAL_KEY }, 'temporal')).toBe(full.TEMPORAL_KEY);
    expect(loadKey({ DATA_KEY: full.DATA_KEY }, 'data')).toEqual({ current: full.DATA_KEY });
    expect(() => loadKey({ DATA_KEY: full.DATA_KEY, JWT_SECRET: 'x'.repeat(64) }, 'temporal')).toThrow(/^TEMPORAL_KEY is not set/);
  });
});
