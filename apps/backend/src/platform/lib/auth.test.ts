import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { hashPassword, verifyPassword, passwordMatches, signJWT, verifyJWT, generateOTP, removalProgressOf, removalProgressToken } from './auth.js';

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

    it('compares a stored hash of another length as wrong rather than throwing', async () => {
      expect(await verifyPassword('anything', 'salt:abcd')).toBe(false);
    });

    it('does the work of a check even for an account with no password, and answers no', async () => {
      expect(await passwordMatches('a-long-password-1', undefined)).toBe(false);
      expect(await passwordMatches('a-long-password-1', await hashPassword('a-long-password-1'))).toBe(true);
    });
  });

  describe('JWT Utilities', () => {
    const secret = 'superSecretJwtKey';

    it('should sign and verify a token successfully', () => {
      const payload = { userId: 'user-123', email: 'test@example.com' };
      const token = signJWT('oauth-state', payload, secret, 3600);

      const verified = verifyJWT(token, 'oauth-state', secret);
      expect(verified).not.toBeNull();
      expect(verified!.userId).toBe('user-123');
      expect(verified!.email).toBe('test@example.com');
      expect(verified!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('should fail verification with wrong secret', () => {
      const payload = { userId: 'user-123' };
      const token = signJWT('oauth-state', payload, secret, 3600);

      const verified = verifyJWT(token, 'oauth-state', 'wrongSecret');
      expect(verified).toBeNull();
    });

    it('should fail verification for expired token', () => {
      const payload = { userId: 'user-123' };
      const token = signJWT('oauth-state', payload, secret, -10);

      const verified = verifyJWT(token, 'oauth-state', secret);
      expect(verified).toBeNull();
    });

    it('refuses a correctly signed token that carries no expiry', () => {
      const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const token = (payload: object) => {
        const signed = `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}`;
        return `${signed}.${createHmac('sha256', secret).update(signed).digest('base64url')}`;
      };
      expect(verifyJWT(token({ userId: 'user-123', purpose: 'oauth-state', exp: Math.floor(Date.now() / 1000) + 60 }), 'oauth-state', secret)).toMatchObject({ userId: 'user-123' });
      expect(verifyJWT(token({ userId: 'user-123', purpose: 'oauth-state' }), 'oauth-state', secret)).toBeNull();
    });

    it('takes a token only for the purpose it was signed for, and refuses one that names none', () => {
      const challenge = signJWT('oauth-state', { twoFactorFor: 'u1', userId: 'u1' }, secret, 60);
      expect(verifyJWT(challenge, 'oauth-state', secret)).toMatchObject({ twoFactorFor: 'u1' });
      expect(verifyJWT(challenge, 'removal-progress', secret)).toBeNull();
      expect(verifyJWT(removalProgressToken('u1', secret), 'oauth-state', secret)).toBeNull();
      const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const signed = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ userId: 'u1', exp: Math.floor(Date.now() / 1000) + 60 })}`;
      expect(verifyJWT(`${signed}.${createHmac('sha256', secret).update(signed).digest('base64url')}`, 'oauth-state', secret)).toBeNull();
    });

    it('signs a token for reading one account\'s removal progress that lasts as long as the removal, and reads nothing else', () => {
      const token = removalProgressToken('bob', secret);
      expect(removalProgressOf(token, secret)).toBe('bob');
      expect(verifyJWT(token, 'removal-progress', secret)).not.toHaveProperty('exp');
      expect(verifyJWT(token, 'oauth-state', secret)).toBeNull();
      expect(removalProgressOf(token, 'wrongSecret')).toBeUndefined();
      expect(removalProgressOf(signJWT('oauth-state', { progressOf: 'bob' }, secret, 60), secret)).toBeUndefined();
      expect(removalProgressOf('not-a-token', secret)).toBeUndefined();
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
