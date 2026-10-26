import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthService, WRONG_CODES_ALLOWED } from './AuthService.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import type { UserMetadata } from '../../platform/lib/types.js';

describe('AuthService', () => {
  let dbMock: MongoDB;

  beforeEach(async () => {
    dbMock = await testDatabase();
  });

  it('should create and verify 2FA challenge successfully', () => {
    const authService = new AuthService(dbMock);
    const userId = 'user-1';

    const code = authService.create2FAChallenge(userId);
    expect(code).toHaveLength(6);

    const isCorrect = authService.verify2FAChallenge(userId, code);
    expect(isCorrect).toBe(true);

    const isAgain = authService.verify2FAChallenge(userId, code);
    expect(isAgain).toBe(false);
  });

  it('should reject incorrect code', () => {
    const authService = new AuthService(dbMock);
    const userId = 'user-2';

    authService.create2FAChallenge(userId);
    const isCorrect = authService.verify2FAChallenge(userId, '000000');
    expect(isCorrect).toBe(false);
  });

  it('should reject expired code', () => {
    const authService = new AuthService(dbMock);
    const userId = 'user-3';

    authService.create2FAChallenge(userId);

    const originalNow = Date.now;
    Date.now = () => originalNow() + 10 * 60 * 1000;

    const isCorrect = authService.verify2FAChallenge(userId, '123456');
    expect(isCorrect).toBe(false);

    Date.now = originalNow;
  });

  it('should log 2FA code in developer warning logs', async () => {
    const authService = new AuthService(dbMock);
    const user: UserMetadata = {
      id: 'user-4',
      email: 'test@example.com',
      twoFactorEnabled: true,
      twoFactorPreferredMethod: 'email',
      emailVerified: true,
      createdAt: new Date().toISOString(),
    };

    const spy = vi.spyOn(authService['logger'], 'warn');
    await authService.send2FACode(user, '999999');

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[DEVELOPER 2FA ALERT]'));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('test@example.com'));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('999999'));
  });

  const person: UserMetadata = { id: 'user-5', email: 'five@example.com', twoFactorEnabled: true, twoFactorPreferredMethod: 'email', emailVerified: true, createdAt: '' } as UserMetadata;

  it('emails the code where the server sends email, and logs nothing of it', async () => {
    const toAddress = vi.fn(async () => undefined);
    const authService = new AuthService(dbMock, { mail: { available: () => ({ ok: true as const }), toAddress }, production: true });
    const warn = vi.spyOn(authService['logger'], 'warn');
    await authService.send2FACode(person, '424242');
    expect(toAddress).toHaveBeenCalledWith('five@example.com', expect.objectContaining({ text: expect.stringContaining('424242') }));
    expect(warn).not.toHaveBeenCalled();
  });

  it('never logs a code in production, and will not switch on a way it cannot send', async () => {
    const authService = new AuthService(dbMock, { mail: { available: () => ({ ok: false as const, why: 'MAIL_SMTP_URL is not set' }), toAddress: vi.fn() }, production: true });
    const warn = vi.spyOn(authService['logger'], 'warn');
    await expect(authService.send2FACode(person, '424242')).rejects.toThrow('a sign-in code cannot be sent by email to five@example.com, since MAIL_SMTP_URL is not set');
    expect(warn).not.toHaveBeenCalled();
    expect(authService.sendingProblem('email')).toBe('sign-in codes by email need this server to send email, and MAIL_SMTP_URL is not set');
    expect(authService.sendingProblem('sms')).toContain('need Twilio');
    expect(new AuthService(dbMock).sendingProblem('email')).toBeUndefined();
  });

  it('ends a challenge after five wrong codes, so the right one no longer works', () => {
    const authService = new AuthService(dbMock);
    const code = authService.create2FAChallenge('user-6');
    const wrong = code === '000000' ? '111111' : '000000';
    for (let n = 0; n < WRONG_CODES_ALLOWED; n += 1) expect(authService.verify2FAChallenge('user-6', wrong)).toBe(false);
    expect(authService.verify2FAChallenge('user-6', code)).toBe(false);
  });
});
