import { describe, it, expect } from 'vitest';
import { encryptValue, decryptValue, maskSecret } from './crypto.js';

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
      // But both decrypt to the same value
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
      // Tamper with the ciphertext portion
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
});
