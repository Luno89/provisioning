import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { hashPassword, verifyPassword, passwordMatches, signJWT, verifyJWT, generateOTP, e2eProblem, signsEveryoneIn, sessionToken, signedSession, sessionEnded, deviceToken, deviceOf } from './auth.js';

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
      const token = signJWT('session', payload, secret, 3600);

      const verified = verifyJWT(token, 'session', secret);
      expect(verified).not.toBeNull();
      expect(verified!.userId).toBe('user-123');
      expect(verified!.email).toBe('test@example.com');
      expect(verified!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('should fail verification with wrong secret', () => {
      const payload = { userId: 'user-123' };
      const token = signJWT('session', payload, secret, 3600);

      const verified = verifyJWT(token, 'session', 'wrongSecret');
      expect(verified).toBeNull();
    });

    it('should fail verification for expired token', () => {
      const payload = { userId: 'user-123' };
      const token = signJWT('session', payload, secret, -10);

      const verified = verifyJWT(token, 'session', secret);
      expect(verified).toBeNull();
    });

    it('refuses a correctly signed token that carries no expiry', () => {
      const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const token = (payload: object) => {
        const signed = `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}`;
        return `${signed}.${createHmac('sha256', secret).update(signed).digest('base64url')}`;
      };
      expect(verifyJWT(token({ userId: 'user-123', purpose: 'session', exp: Math.floor(Date.now() / 1000) + 60 }), 'session', secret)).toMatchObject({ userId: 'user-123' });
      expect(verifyJWT(token({ userId: 'user-123', purpose: 'session' }), 'session', secret)).toBeNull();
    });

    it('takes a token only for the purpose it was signed for, and refuses one that names none', () => {
      const challenge = signJWT('two-factor', { twoFactorFor: 'u1', userId: 'u1' }, secret, 60);
      expect(verifyJWT(challenge, 'two-factor', secret)).toMatchObject({ twoFactorFor: 'u1' });
      expect(verifyJWT(challenge, 'session', secret)).toBeNull();
      const device = deviceToken('ann@example.com', secret, 'd1');
      expect(verifyJWT(device, 'session', secret)).toBeNull();
      expect(deviceOf(device, secret)).toEqual({ account: 'ann@example.com', id: 'd1' });
      expect(deviceOf(challenge, secret)).toBeUndefined();
      const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const signed = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ userId: 'u1', exp: Math.floor(Date.now() / 1000) + 60 })}`;
      expect(verifyJWT(`${signed}.${createHmac('sha256', secret).update(signed).digest('base64url')}`, 'session', secret)).toBeNull();
    });
  });

  describe('session tokens', () => {
    const secret = 'session-secret';

    it('carry an id of their own, when they began and when they end', () => {
      const one = signedSession(verifyJWT(sessionToken({ id: 'u1', email: 'u1@example.com' }, secret, { now: 5_000 }), 'session', secret));
      const two = signedSession(verifyJWT(sessionToken({ id: 'u1', email: 'u1@example.com' }, secret, { now: 5_000 }), 'session', secret));
      expect(one).toMatchObject({ userId: 'u1', sessionAt: 5_000 });
      expect(one!.jti).not.toBe(two!.jti);
      expect(one!.until).toBeGreaterThan(Date.now());
    });

    it('are not taken without when they began or without an id, since nothing could ever end them', () => {
      expect(signedSession(verifyJWT(signJWT('session', { userId: 'u1', jti: 'j1' }, secret, 60), 'session', secret))).toBeUndefined();
      expect(signedSession(verifyJWT(signJWT('session', { userId: 'u1', sessionAt: 1 }, secret, 60), 'session', secret))).toBeUndefined();
    });

    it('end when the account signed out everywhere after they began', () => {
      expect(sessionEnded({ sessionAt: 1_000 }, { sessionsEndedAt: new Date(2_000).toISOString() })).toBe(true);
      expect(sessionEnded({ sessionAt: 3_000 }, { sessionsEndedAt: new Date(2_000).toISOString() })).toBe(false);
      expect(sessionEnded({ sessionAt: 3_000 }, {})).toBe(false);
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
