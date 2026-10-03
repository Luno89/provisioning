import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { encryptValue, decryptValue, maskSecret, keyId, needsReencryption, looksEncrypted } from './crypto.js';

const TEST_KEY = 'test-master-key-for-unit-tests-only';

describe('crypto', () => {
  describe('encryptValue / decryptValue', () => {
    it('round-trips a plaintext string', () => {
      const plaintext = 'AKIAIOSFODNN7EXAMPLE';
      const encrypted = encryptValue(plaintext, TEST_KEY);
      const decrypted = decryptValue(encrypted, TEST_KEY);
      expect(decrypted).toBe(plaintext);
    });

    it('encrypts a JSON blob', () => {
      const json = JSON.stringify({ type: 'service_account', project_id: 'test-123' });
      const encrypted = encryptValue(json, TEST_KEY);
      const decrypted = decryptValue(encrypted, TEST_KEY);
      expect(JSON.parse(decrypted)).toEqual({ type: 'service_account', project_id: 'test-123' });
    });

    it('produces different ciphertexts for the same plaintext (random IV)', () => {
      const plaintext = 'same-secret';
      const a = encryptValue(plaintext, TEST_KEY);
      const b = encryptValue(plaintext, TEST_KEY);
      expect(a).not.toBe(b);
      expect(decryptValue(a, TEST_KEY)).toBe(plaintext);
      expect(decryptValue(b, TEST_KEY)).toBe(plaintext);
    });

    it('fails with a different key', () => {
      const encrypted = encryptValue('secret', TEST_KEY);
      expect(() => decryptValue(encrypted, 'wrong-key')).toThrow();
    });

    it('fails with tampered ciphertext', () => {
      const encrypted = encryptValue('secret', TEST_KEY);
      const parts = encrypted.split(':');
      const tampered = `${parts[0]}:${parts[1]}:${'ff'.repeat(16)}`;
      expect(() => decryptValue(tampered, TEST_KEY)).toThrow();
    });

    it('throws on malformed input', () => {
      expect(() => decryptValue('not:valid', TEST_KEY)).toThrow('Invalid encrypted value format');
      expect(() => decryptValue('single', TEST_KEY)).toThrow('Invalid encrypted value format');
    });

    it('handles empty string', () => {
      const encrypted = encryptValue('', TEST_KEY);
      const decrypted = decryptValue(encrypted, TEST_KEY);
      expect(decrypted).toBe('');
    });

    it('handles unicode characters', () => {
      const plaintext = '🔑 ünïcödé kéy';
      const encrypted = encryptValue(plaintext, TEST_KEY);
      const decrypted = decryptValue(encrypted, TEST_KEY);
      expect(decrypted).toBe(plaintext);
    });
  });

  describe('maskSecret', () => {
    it('masks a normal-length string', () => {
      expect(maskSecret('AKIAIOSFODNN7EXAMPLE')).toBe('AKIA****MPLE');
    });

    it('masks a short string completely', () => {
      expect(maskSecret('abc')).toBe('****');
    });

    it('masks with custom prefix/suffix lengths', () => {
      expect(maskSecret('1234567890', 2, 2)).toBe('12****90');
    });

    it('handles exact boundary length', () => {
      expect(maskSecret('12345678', 4, 4)).toBe('****');
    });
  });

  describe('keys that change', () => {
    const legacy = (plaintext: string, secret: string): string => {
      const key = crypto.scryptSync(secret, 'ianthe-credential-encryption-v1', 32);
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = cipher.update(plaintext, 'utf8', 'hex') + cipher.final('hex');
      return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${body}`;
    };

    it('says which key it used, so a rotated key is told apart from a wrong one', () => {
      const encrypted = encryptValue('hello', 'key-one');
      expect(encrypted).toMatch(new RegExp(`^v2:${keyId('key-one')}:`));
      expect(() => decryptValue(encrypted, 'key-two')).toThrow(`encrypted with key ${keyId('key-one')}, which this platform no longer holds`);
    });

    it('opens what an older key wrote, and anything written before keys had ids', () => {
      const ring = { current: 'new-key', previous: ['old-key'] };
      expect(decryptValue(encryptValue('rotated', 'old-key'), ring)).toBe('rotated');
      expect(decryptValue(legacy('before ids', 'old-key'), ring)).toBe('before ids');
      expect(() => decryptValue(legacy('nobody', 'stranger'), ring)).toThrow();
    });

    it('writes only with the current key, and says what still needs moving onto it', () => {
      const ring = { current: 'new-key', previous: ['old-key'] };
      const fresh = encryptValue('x', ring);
      expect(decryptValue(fresh, 'new-key')).toBe('x');
      expect(needsReencryption(fresh, ring)).toBe(false);
      expect(needsReencryption(encryptValue('x', 'old-key'), ring)).toBe(true);
      expect(needsReencryption(legacy('x', 'new-key'), ring)).toBe(true);
      expect(looksEncrypted('not:a:secret')).toBe(false);
    });
  });
});
