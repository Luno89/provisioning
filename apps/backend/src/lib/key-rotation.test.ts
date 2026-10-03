import { describe, it, expect } from 'vitest';
import { reencrypt } from './key-rotation.js';
import { decryptValue, encryptValue, keyId } from './crypto.js';

const ring = { current: 'new-key', previous: ['old-key'] };

describe('moving stored secrets onto the current key', () => {
  it('rewrites every value an older key wrote, wherever it sits in the document, and says where', () => {
    const doc = {
      _id: 'u1',
      email: 'a@b.c',
      credentials: { hetzner: { token: encryptValue('hz', 'old-key') }, aws: [encryptValue('ak', 'old-key')] },
      current: encryptValue('fine', 'new-key'),
      createdAt: new Date(0),
    };

    const result = reencrypt(doc, ring);

    expect(result.rewritten).toEqual(['credentials.hetzner.token', 'credentials.aws[0]']);
    expect(result.value.credentials.hetzner.token.split(':')[1]).toBe(keyId('new-key'));
    expect(decryptValue(result.value.credentials.hetzner.token, 'new-key')).toBe('hz');
    expect(result.value.current).toBe(doc.current);
    expect(result.value.createdAt).toBe(doc.createdAt);
    expect(result.value.email).toBe('a@b.c');
  });

  it('leaves alone what no key it holds can open, and reports it rather than guessing', () => {
    const stranger = encryptValue('not ours', 'someone-elses-key');
    const result = reencrypt({ secret: stranger }, ring);

    expect(result.rewritten).toEqual([]);
    expect(result.unreadable).toEqual(['secret']);
    expect(result.value.secret).toBe(stranger);
  });
});
