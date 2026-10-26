import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { hashPassword, verifyPassword, signJWT, verifyJWT, generateOTP, e2eProblem, signsEveryoneIn } from './auth.js';

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
      const token = signJWT(payload, secret, -10);

      const verified = verifyJWT(token, secret);
      expect(verified).toBeNull();
    });

    it('refuses a correctly signed token that carries no expiry', () => {
      const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const token = (payload: object) => {
        const signed = `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}`;
        return `${signed}.${createHmac('sha256', secret).update(signed).digest('base64url')}`;
      };
      expect(verifyJWT(token({ userId: 'user-123', exp: Math.floor(Date.now() / 1000) + 60 }), secret)).toMatchObject({ userId: 'user-123' });
      expect(verifyJWT(token({ userId: 'user-123' }), secret)).toBeNull();
    });
  });

  describe('the e2e sign-in', () => {
    it('signs everyone in only outside production, and production refuses to start with it', () => {
      expect(signsEveryoneIn({ IS_E2E: 'true' })).toBe(true);
      expect(signsEveryoneIn({ IS_E2E: 'true', NODE_ENV: 'production' })).toBe(false);
      expect(e2eProblem({ IS_E2E: 'true', NODE_ENV: 'production' })).toContain('refuses to start');
      expect(e2eProblem({ IS_E2E: 'true' })).toBeUndefined();
      expect(e2eProblem({ NODE_ENV: 'production' })).toBeUndefined();
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
