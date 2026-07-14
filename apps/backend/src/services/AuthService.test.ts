import { describe, it, expect, vi } from 'vitest';
import { AuthService } from './AuthService.js';
import { LocalDB } from '../lib/db.js';
import type { UserMetadata } from '../lib/types.js';

describe('AuthService', () => {
  const dbMock = {} as LocalDB;

  it('should create and verify 2FA challenge successfully', () => {
    const authService = new AuthService(dbMock);
    const userId = 'user-1';

    const code = authService.create2FAChallenge(userId);
    expect(code).toHaveLength(6);

    const isCorrect = authService.verify2FAChallenge(userId, code);
    expect(isCorrect).toBe(true);

    // Verify code is consumed and deleted
    const isAgain = authService.verify2FAChallenge(userId, code);
    expect(isAgain).toBe(false);
  });

  it('should reject incorrect code', () => {
    const authService = new AuthService(dbMock);
    const userId = 'user-2';

    const code = authService.create2FAChallenge(userId);
    const isCorrect = authService.verify2FAChallenge(userId, '000000');
    expect(isCorrect).toBe(false);
  });

  it('should reject expired code', () => {
    const authService = new AuthService(dbMock);
    const userId = 'user-3';

    authService.create2FAChallenge(userId);

    // Mock Date.now() to 10 minutes in the future
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
});
