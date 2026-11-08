import { describe, it, expect } from 'vitest';
import { identityKeyOf, missingKeyLines, reencrypt, sealedBeforeKeys } from './key-rotation.js';
import { identityKeysFrom } from '../../instances/lib/identity-token.js';
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

describe('the migration off JWT_SECRET', () => {
  const OLD_SECRET = 'one-dev-secret';
  const SEALED_BY_DERIVED_KEY = 'd29de6e1e196ab2dff54366ae6fc9cddf27b3ba9d4f69973895aa3a8b2ea3077';
  const ROOT_KID_FROM_OLD_SECRET = '3e029af2841683f9';

  it('re-seals onto DATA_KEY what the old single secret wrote, and what the key a dev box derived from it wrote', () => {
    const current = { current: 'd'.repeat(64) };
    const ring = sealedBeforeKeys(current, OLD_SECRET, 'data');
    const doc = { byOldSecret: encryptValue('stored long ago', OLD_SECRET), byDerivedKey: encryptValue('stored last week', SEALED_BY_DERIVED_KEY), already: encryptValue('fine', current) };
    const result = reencrypt(doc, ring);
    expect(result.rewritten).toEqual(['byOldSecret', 'byDerivedKey']);
    expect(result.unreadable).toEqual([]);
    expect(decryptValue(result.value.byOldSecret, current)).toBe('stored long ago');
    expect(decryptValue(result.value.byDerivedKey, current)).toBe('stored last week');
  });

  it('holds only DATA_KEY when there is no JWT_SECRET to re-seal from, so what it wrote is reported unreadable', () => {
    expect(sealedBeforeKeys({ current: 'd'.repeat(64) }, undefined, 'data')).toEqual({ current: 'd'.repeat(64) });
    expect(reencrypt({ old: encryptValue('x', SEALED_BY_DERIVED_KEY) }, sealedBeforeKeys({ current: 'd'.repeat(64) }, '  ', 'data')).unreadable).toEqual(['old']);
  });

  it('writes the five keys a .env lacks, fresh, and root\'s identity key as the one it signed with from JWT_SECRET', () => {
    let made = 0;
    const make = { key: () => `fresh-key-${++made}`.padEnd(64, '0'), identity: () => 'a-new-identity' };
    const present = 'SESSION_KEY=' + 's'.repeat(64) + '\nDATA_KEY=short\n';
    const written = missingKeyLines(present, make, OLD_SECRET);
    expect(written.lines.map((line) => line.split('=')[0])).toEqual(['DATA_KEY', 'PAYLOAD_KEY', 'EGRESS_KEY', 'TEMPORAL_KEY', 'ROOT_IDENTITY_KEY']);
    expect(written.lines[0]).toBe(`DATA_KEY=${'fresh-key-1'.padEnd(64, '0')}`);
    const identity = Buffer.from(written.lines[4]!.slice('ROOT_IDENTITY_KEY='.length), 'base64').toString('utf8');
    expect(identityKeysFrom(identity).kid).toBe(ROOT_KID_FROM_OLD_SECRET);
    expect(identityKeysFrom(identityKeyOf(OLD_SECRET)).kid).toBe(ROOT_KID_FROM_OLD_SECRET);
  });

  it('makes a new identity key without JWT_SECRET, and none for an instance\'s or a complete .env', () => {
    const make = { key: () => 'k'.repeat(64), identity: () => '-----BEGIN PRIVATE KEY-----' };
    expect(missingKeyLines('', make, undefined).lines.at(-1)).toBe(`ROOT_IDENTITY_KEY=${Buffer.from('-----BEGIN PRIVATE KEY-----').toString('base64')}`);
    expect(missingKeyLines('ROLE=instance\n', make, OLD_SECRET).written).not.toContain('ROOT_IDENTITY_KEY');
    const complete = ['SESSION_KEY', 'DATA_KEY', 'PAYLOAD_KEY', 'EGRESS_KEY', 'TEMPORAL_KEY'].map((name) => `${name}=${'x'.repeat(64)}`).join('\n') + '\nROOT_IDENTITY_KEY=abc\n';
    expect(missingKeyLines(complete, make, OLD_SECRET)).toEqual({ lines: [], written: [] });
  });
});
