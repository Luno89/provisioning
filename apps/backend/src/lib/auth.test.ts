import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, signJWT, verifyJWT, generateOTP } from './auth.js';

describe('Auth Utilities', () => {
  describe('Password Hashing', () => {
    it('should hash a password and verify it successfully', async () => {
      const password = 'mySecurePassword123';
      const hash = await hashPassword(password);
      expect(hash).toContain(':');

      const isCorrect = await verifyPassword(password, hash);
      expect(isCorrect).toBe(true);

      const isWrong = await verifyPassword('wrongpassword', hash);
      expect(isWrong).toBe(false);
    });
  });

  describe('JWT Utilities', () => {
    const secret = 'superSecretJwtKey';

    it('should sign and verify a token successfully', () => {
      const payload = { userId: 'user-123', email: 'test@example.com' };
      const token = signJWT(payload, secret, 3600);

      const verified = verifyJWT(token, secret);
      expect(verified).not.toBeNull();
      expect(verified!.userId).toBe('user-123');
      expect(verified!.email).toBe('test@example.com');
      expect(verified!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('should fail verification with wrong secret', () => {
      const payload = { userId: 'user-123' };
      const token = signJWT(payload, secret, 3600);

      const verified = verifyJWT(token, 'wrongSecret');
      expect(verified).toBeNull();
    });

    it('should fail verification for expired token', () => {
      const payload = { userId: 'user-123' };
      const token = signJWT(payload, secret, -10); // Expired 10 seconds ago

      const verified = verifyJWT(token, secret);
      expect(verified).toBeNull();
    });
  });

  describe('OTP Utilities', () => {
    it('should generate a 6-digit numeric OTP', () => {
      const otp = generateOTP();
      expect(otp).toHaveLength(6);
      expect(/^\d{6}$/.test(otp)).toBe(true);
    });
  });
});
