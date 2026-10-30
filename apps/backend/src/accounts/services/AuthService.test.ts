import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthService } from './AuthService.js';
import { hashPassword } from '../../platform/lib/auth.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import type { UserMetadata } from '../../platform/lib/types.js';

describe('AuthService', () => {
  let dbMock: MongoDB;

  beforeEach(async () => {
    dbMock = await testDatabase();
  });

  const codeMail = () => {
    const sent: string[] = [];
    const mail = { available: () => ({ ok: true as const }), toAddress: vi.fn(async (_to: string, message: { text: string }) => { sent.push(/\b(\d{6})\b/.exec(message.text)![1]!); }) };
    return { sent, mail };
  };
  const someone = (id: string, extra: Partial<UserMetadata> = {}): UserMetadata => ({ id, email: `${id}@example.com`, twoFactorEnabled: true, twoFactorPreferredMethod: 'email', emailVerified: true, createdAt: '', ...extra });

  it('emails a sign-in code that works once, and is kept only as a hash', async () => {
    const { sent, mail } = codeMail();
    const authService = new AuthService(dbMock, { mail });
    expect(await authService.sendCode(someone('user-1'), 'sign-in')).toEqual({ kind: 'sent' });
    const held = await dbMock.accounts.getTwoFactorCode('sign-in:user-1');
    expect(JSON.stringify(held)).not.toContain(sent[0]);
    expect(await authService.checkCode('user-1', 'sign-in', sent[0]!)).toEqual({ kind: 'ok' });
    expect(await authService.checkCode('user-1', 'sign-in', sent[0]!)).toEqual({ kind: 'wrong' });
  });

  it('keeps a confirmation code apart from a sign-in code', async () => {
    const { sent, mail } = codeMail();
    const authService = new AuthService(dbMock, { mail });
    await authService.sendCode(someone('user-2'), 'confirm');
    expect(await authService.checkCode('user-2', 'sign-in', sent[0]!)).toEqual({ kind: 'wrong' });
    expect(await authService.checkCode('user-2', 'confirm', sent[0]!)).toEqual({ kind: 'ok' });
  });

  it('refuses a code once it has expired', async () => {
    const { sent, mail } = codeMail();
    let clock = Date.now();
    const authService = new AuthService(dbMock, { mail, now: () => clock });
    await authService.sendCode(someone('user-3'), 'sign-in');
    clock += 10 * 60 * 1000;
    expect(await authService.checkCode('user-3', 'sign-in', sent[0]!)).toEqual({ kind: 'wrong' });
  });

  it('counts wrong codes per account across sign-ins, so a fresh sign-in does not start the count again, and locks codes for fifteen minutes', async () => {
    const { sent, mail } = codeMail();
    let clock = Date.now();
    const authService = new AuthService(dbMock, { mail, now: () => clock });
    const user = someone('user-6');
    const wrongFor = (code: string) => (code === '000000' ? '111111' : '000000');
    for (let signIn = 0; signIn < 2; signIn += 1) {
      await authService.sendCode(user, 'sign-in');
      const code = sent[sent.length - 1]!;
      expect(await authService.checkCode(user.id, 'sign-in', wrongFor(code))).toEqual({ kind: 'wrong' });
      expect(await authService.checkCode(user.id, 'sign-in', wrongFor(code))).toEqual({ kind: 'wrong' });
    }
    await authService.sendCode(user, 'confirm');
    const last = sent[sent.length - 1]!;
    expect(await authService.checkCode(user.id, 'confirm', wrongFor(last))).toMatchObject({ kind: 'locked' });
    expect(await authService.checkCode(user.id, 'confirm', last)).toMatchObject({ kind: 'locked', said: expect.stringContaining('15 minutes') });
    expect(await authService.sendCode(user, 'sign-in')).toMatchObject({ kind: 'locked' });
    expect(mail.toAddress).toHaveBeenCalledTimes(3);
    clock += 16 * 60 * 1000;
    await authService.sendCode(user, 'sign-in');
    expect(await authService.checkCode(user.id, 'sign-in', sent[sent.length - 1]!)).toEqual({ kind: 'ok' });
  });

  it('locks an account after ten wrong passwords from strangers, tells its person once by email and push, and keeps the locked browser\'s own count apart', async () => {
    const mailed: Array<{ to: string; subject: string; text: string }> = [];
    const pushed: Array<{ ownerId: string; title: string; body: string }> = [];
    const authService = new AuthService(dbMock, {
      mail: { available: () => ({ ok: true as const }), toAddress: async (to, message) => { mailed.push({ to, subject: message.subject, text: message.text ?? '' }); } },
      push: { toPerson: async (ownerId, message) => { pushed.push({ ownerId, ...message }); return 1; } },
    });
    const user = someone('user-7', { twoFactorEnabled: false, passwordHash: await hashPassword('the-real-password-1') });
    const answers: string[] = [];
    for (let n = 0; n < 11; n += 1) answers.push((await authService.checkPassword(user.email, user, 'not-the-password-1', undefined, '198.51.100.4')).kind);
    expect(answers.slice(0, 10)).toEqual(Array(10).fill('wrong'));
    expect(answers[10]).toBe('locked');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mailed).toEqual([expect.objectContaining({ to: 'user-7@example.com', subject: 'Your Koala account is locked to other browsers' })]);
    expect(mailed[0]!.text).toContain('10 times from 198.51.100.4');
    expect(pushed).toEqual([expect.objectContaining({ ownerId: 'user-7', title: 'Your account is locked to other browsers' })]);
    expect(await authService.checkPassword(user.email, user, 'the-real-password-1', { account: user.email, id: 'own-browser' })).toEqual({ kind: 'ok' });
    for (let n = 0; n < 10; n += 1) await authService.checkPassword(user.email, user, 'not-the-password-1', { account: user.email, id: 'own-browser' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mailed).toHaveLength(1);
    expect(pushed).toHaveLength(1);
  });

  it('answers a sign-in for an account that does not exist as it answers a wrong password', async () => {
    const authService = new AuthService(dbMock);
    expect(await authService.checkPassword('nobody@example.com', undefined, 'some-long-password', undefined)).toEqual({ kind: 'wrong' });
  });

  it('asks a risky change for a code with two-factor on, the password with it off, and an emailed code from an account with no password', async () => {
    const { sent, mail } = codeMail();
    const authService = new AuthService(dbMock, { mail });
    const withTwoFactor = someone('user-8', { passwordHash: await hashPassword('the-real-password-1') });
    expect(await authService.confirmProblem(withTwoFactor, { password: 'the-real-password-1' }, undefined)).toEqual({ status: 403, error: 'Enter a current code from your two-factor sign-in to do this' });
    await authService.sendCode(withTwoFactor, 'confirm');
    expect(await authService.confirmProblem(withTwoFactor, { code: sent[0]! }, undefined)).toBeUndefined();
    const withPassword = someone('user-9', { twoFactorEnabled: false, passwordHash: await hashPassword('the-real-password-1') });
    expect(await authService.confirmProblem(withPassword, {}, undefined)).toEqual({ status: 403, error: 'Enter your password to do this' });
    expect(await authService.confirmProblem(withPassword, { password: 'not-it-at-all-1' }, undefined)).toEqual({ status: 403, error: 'That is not your password' });
    expect(await authService.confirmProblem(withPassword, { password: 'the-real-password-1' }, undefined)).toBeUndefined();
    const noPassword = someone('user-10', { twoFactorEnabled: false });
    expect(await authService.confirmProblem(noPassword, { password: 'anything-at-all-1' }, undefined)).toEqual({ status: 403, error: 'Enter the code we email you to do this' });
    await authService.sendCode(noPassword, 'confirm');
    expect(mail.toAddress).toHaveBeenLastCalledWith('user-10@example.com', expect.objectContaining({ subject: 'Your Koala confirmation code' }));
    expect(await authService.confirmProblem(noPassword, { code: sent[sent.length - 1]! }, undefined)).toBeUndefined();
  });

  it('asks the current password to change it, and a code as well with two-factor on', async () => {
    const { sent, mail } = codeMail();
    const authService = new AuthService(dbMock, { mail });
    const user = someone('user-11', { passwordHash: await hashPassword('the-real-password-1') });
    expect(await authService.passwordChangeProblem(user, {}, undefined)).toEqual({ status: 403, error: 'Enter your current password to change it' });
    expect(await authService.passwordChangeProblem(user, { current: 'wrong-password-12' }, undefined)).toEqual({ status: 403, error: 'That is not your current password' });
    expect((await authService.passwordChangeProblem(user, { current: 'the-real-password-1' }, undefined))?.error).toContain('two-factor');
    await authService.sendCode(user, 'confirm');
    expect(await authService.passwordChangeProblem(user, { current: 'the-real-password-1', code: sent[0]! }, undefined)).toBeUndefined();
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

  it('emails a sign-up code where the server sends email, and logs nothing of it', async () => {
    const toAddress = vi.fn(async () => undefined);
    const authService = new AuthService(dbMock, { mail: { available: () => ({ ok: true as const }), toAddress }, production: true });
    const warn = vi.spyOn(authService['logger'], 'warn');
    expect(await authService.sendSignUpCode('new@example.com', '135790')).toEqual({ kind: 'sent' });
    expect(toAddress).toHaveBeenCalledWith('new@example.com', expect.objectContaining({ subject: 'Your Koala sign-up code', text: expect.stringContaining('135790') }));
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses a sign-up in production when no email can be sent, never logging or handing back its code', async () => {
    const authService = new AuthService(dbMock, { mail: { available: () => ({ ok: false as const, why: 'MAIL_SMTP_URL is not set' }), toAddress: vi.fn() }, production: true });
    const warn = vi.spyOn(authService['logger'], 'warn');
    const answer = await authService.sendSignUpCode('new@example.com', '135790');
    expect(answer).toEqual({ kind: 'refused', why: 'This server cannot send email yet (MAIL_SMTP_URL is not set), so it cannot confirm your address; ask whoever runs it' });
    expect(JSON.stringify(answer)).not.toContain('135790');
    expect(warn).not.toHaveBeenCalled();
  });

  it('shows a sign-up code to the developer outside production when no email can be sent', async () => {
    const authService = new AuthService(dbMock);
    const warn = vi.spyOn(authService['logger'], 'warn');
    expect(await authService.sendSignUpCode('new@example.com', '135790')).toEqual({ kind: 'shown', code: '135790' });
    expect(authService.codeDelivery()).toEqual({ kind: 'shown' });
    expect(new AuthService(dbMock, { production: true }).codeDelivery()).toMatchObject({ kind: 'refused' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('new@example.com'));
  });

  it('sends an account at most five confirmation codes in fifteen minutes, counted in the database', async () => {
    const { mail } = codeMail();
    const clock = Date.now();
    const authService = new AuthService(dbMock, { mail, now: () => clock });
    const user = someone('user-12');
    for (let n = 0; n < 5; n += 1) expect(await authService.sendConfirmCode(user)).toEqual({ kind: 'sent' });
    expect(await authService.sendConfirmCode(user)).toEqual({ kind: 'limited', said: expect.stringContaining('5 confirmation codes in the last 15 minutes') });
    expect(await new AuthService(dbMock, { mail, now: () => clock + 60_000 }).sendConfirmCode(user)).toMatchObject({ kind: 'limited' });
    expect(mail.toAddress).toHaveBeenCalledTimes(5);
    expect(await new AuthService(dbMock, { mail, now: () => clock + 15 * 60_000 + 1 }).sendConfirmCode(user)).toEqual({ kind: 'sent' });
  });
});
