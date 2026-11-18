import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { identityKeysFromSeed } from './identity-token.js';

describe('root\'s identity key', () => {
  it('derives the same key from the same seed, for development without a stored key', () => {
    const seed = crypto.randomBytes(32);
    expect(identityKeysFromSeed(seed).kid).toBe(identityKeysFromSeed(seed).kid);
    expect(identityKeysFromSeed(seed).kid).not.toBe(identityKeysFromSeed(crypto.randomBytes(32)).kid);
  });
});
