import { EventEmitter } from 'node:events';
import https from 'https';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPassword } from '../../platform/lib/auth.js';
import type { UserMetadata } from '../../platform/lib/types.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { AuthService, type CodeMail } from './AuthService.js';

vi.mock('https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('https')>();
  return { ...actual, default: { ...actual, request: vi.fn() } };
});

type TwilioRequest = { options: https.RequestOptions; written: string[] };

function twilioAnswers(status: number, body: string, requests: TwilioRequest[] = []): TwilioRequest[] {
  vi.mocked(https.request).mockImplementation(((options: https.RequestOptions, onResponse: (res: EventEmitter & { statusCode: number }) => void) => {
    const written: string[] = [];
    requests.push({ options, written });
    const req = Object.assign(new EventEmitter(), {
      write: (chunk: string) => { written.push(chunk); },
      end: () => {
        const res = Object.assign(new EventEmitter(), { statusCode: status });
        onResponse(res);
        res.emit('data', body);
        res.emit('end');
      },
    });
    return req;
  }) as never);
  return requests;
}

const codeMail = () => {
  const sent: string[] = [];
  const mail = { available: () => ({ ok: true as const }), toAddress: vi.fn(async (_to: string, message: { text: string }) => { sent.push(/\b(\d{6})\b/.exec(message.text)![1]!); }) };
  return { sent, mail };
};

const someone = (id: string, extra: Partial<UserMetadata> = {}): UserMetadata => ({ id, email: `${id}@example.com`, twoFactorEnabled: true, twoFactorPreferredMethod: 'email', emailVerified: true, createdAt: '', ...extra });

const unavailable = (why: string): CodeMail => ({ available: () => ({ ok: false as const, why }), toAddress: vi.fn() });

describe('AuthService', () => {
  it('emails a sign-in code that works once, and is kept only as a hash', async () => {
    const db = memoryDatabase();
    const { sent, mail } = codeMail();
    const authService = new AuthService(db, { mail });
    expect(await authService.sendCode(someone('user-1'), 'sign-in')).toEqual({ kind: 'sent' });
    const held = await db.accounts.getTwoFactorCode('sign-in:user-1');
    expect(JSON.stringify(held)).not.toContain(sent[0]);
    expect(await authService.checkCode('user-1', 'sign-in', sent[0]!)).toEqual({ kind: 'ok' });
    expect(await authService.checkCode('user-1', 'sign-in', sent[0]!)).toEqual({ kind: 'wrong' });
  });

  it('keeps a confirmation code apart from a sign-in code', async () => {
    const { sent, mail } = codeMail();
    const authService = new AuthService(memoryDatabase(), { mail });
    await authService.sendCode(someone('user-2'), 'confirm');
    expect(await authService.checkCode('user-2', 'sign-in', sent[0]!)).toEqual({ kind: 'wrong' });
    expect(await authService.checkCode('user-2', 'confirm', sent[0]!)).toEqual({ kind: 'ok' });
  });

  it('refuses a code once it has expired', async () => {
    const { sent, mail } = codeMail();
    let clock = Date.now();
    const authService = new AuthService(memoryDatabase(), { mail, now: () => clock });
    await authService.sendCode(someone('user-3'), 'sign-in');
    clock += 10 * 60 * 1000;
    expect(await authService.checkCode('user-3', 'sign-in', sent[0]!)).toEqual({ kind: 'wrong' });
  });

  it('counts wrong codes per account across sign-ins, so a fresh sign-in does not start the count again, and locks codes for fifteen minutes', async () => {
    const { sent, mail } = codeMail();
    let clock = Date.now();
    const authService = new AuthService(memoryDatabase(), { mail, now: () => clock });
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
    const lockedOut = await authService.checkCode(user.id, 'confirm', last);
    expect(lockedOut.kind).toBe('locked');
    expect(lockedOut.kind === 'locked' ? lockedOut.said : '').toContain('15 minutes');
    expect(await authService.sendCode(user, 'sign-in')).toMatchObject({ kind: 'locked' });
    expect(await authService.codesLockedSaid(user.id)).toContain('15 minutes');
    expect(mail.toAddress).toHaveBeenCalledTimes(3);
    clock += 16 * 60 * 1000;
    expect(await authService.codesLockedSaid(user.id)).toBeUndefined();
    await authService.sendCode(user, 'sign-in');
    expect(await authService.checkCode(user.id, 'sign-in', sent[sent.length - 1]!)).toEqual({ kind: 'ok' });
  });

  describe('passwords', () => {
    it('locks an account after ten wrong passwords from strangers, tells its person once by email and push, and keeps the locked browser\'s own count apart', async () => {
      const mailed: Array<{ to: string; subject: string; text: string }> = [];
      const pushed: Array<{ ownerId: string; title: string; body: string }> = [];
      const authService = new AuthService(memoryDatabase(), {
        mail: { available: () => ({ ok: true as const }), toAddress: async (to, message) => { mailed.push({ to, subject: message.subject, text: message.text ?? '' }); } },
        push: { toPerson: async (ownerId, message) => { pushed.push({ ownerId, ...message }); toldByPush(); return 1; } },
      });
      let toldByPush!: () => void;
      const pushedOnce = new Promise<void>((done) => { toldByPush = done; });
      const user = someone('user-7', { twoFactorEnabled: false, passwordHash: await hashPassword('the-real-password-1') });
      const answers: string[] = [];
      for (let n = 0; n < 11; n += 1) answers.push((await authService.checkPassword(user.email, user, 'not-the-password-1', undefined, '198.51.100.4')).kind);
      expect(answers.slice(0, 10)).toEqual(Array(10).fill('wrong'));
      expect(answers[10]).toBe('locked');
      await pushedOnce;
      expect(mailed).toEqual([expect.objectContaining({ to: 'user-7@example.com', subject: 'Your Koala account is locked to other browsers' })]);
      expect(mailed[0]!.text).toContain('10 times from 198.51.100.4');
      expect(pushed).toEqual([expect.objectContaining({ ownerId: 'user-7', title: 'Your account is locked to other browsers' })]);
      expect(await authService.checkPassword(user.email, user, 'the-real-password-1', { account: user.email, id: 'own-browser' })).toEqual({ kind: 'ok' });
      for (let n = 0; n < 10; n += 1) await authService.checkPassword(user.email, user, 'not-the-password-1', { account: user.email, id: 'own-browser' });
      expect(mailed).toHaveLength(1);
      expect(pushed).toHaveLength(1);
    });

    it('answers a sign-in for an account that does not exist as it answers a wrong password', async () => {
      const authService = new AuthService(memoryDatabase());
      expect(await authService.checkPassword('nobody@example.com', undefined, 'some-long-password', undefined)).toEqual({ kind: 'wrong' });
    });

    it('forgets an account\'s wrong passwords when asked, so a reset starts it afresh', async () => {
      const authService = new AuthService(memoryDatabase());
      const user = someone('user-13', { twoFactorEnabled: false, passwordHash: await hashPassword('the-real-password-1') });
      for (let n = 0; n < 10; n += 1) await authService.checkPassword(user.email, user, 'not-the-password-1', undefined);
      expect((await authService.checkPassword(user.email, user, 'the-real-password-1', undefined)).kind).toBe('locked');
      await authService.forgetPasswordFailures(user.email);
      expect(await authService.checkPassword(user.email, user, 'the-real-password-1', undefined)).toEqual({ kind: 'ok' });
    });

    it('tells a locked account\'s person by whichever way works when the other fails', async () => {
      const toAddress = vi.fn(async () => { throw new Error('smtp down'); });
      const toPerson = vi.fn(async () => { throw new Error('no subscription'); });
      const authService = new AuthService(memoryDatabase(), { mail: { available: () => ({ ok: true as const }), toAddress }, push: { toPerson } });
      const warn = vi.spyOn(authService['logger'], 'warn');
      await authService.tellLocked(someone('user-14'), undefined);
      expect(toAddress.mock.calls[0]).toEqual(['user-14@example.com', expect.anything()]);
      expect(String((toAddress.mock.calls[0] as unknown as [string, { text: string }])[1].text)).toContain('from an address we could not tell');
      expect(toPerson).toHaveBeenCalledWith('user-14', expect.objectContaining({ tag: 'account-locked' }));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('was not told by email'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('was not told by push'));
    });

    it('does not email a locked account\'s person when the server sends no email', async () => {
      const mail = unavailable('no mail here');
      const authService = new AuthService(memoryDatabase(), { mail });
      await authService.tellLocked(someone('user-15'), '198.51.100.4');
      expect(mail.toAddress).not.toHaveBeenCalled();
    });
  });

  describe('proving it is the person before a risky change', () => {
    it('asks a code with two-factor on, the password with it off, and an emailed code from an account with no password', async () => {
      const { sent, mail } = codeMail();
      const authService = new AuthService(memoryDatabase(), { mail });
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

    it('refuses a wrong code, saying to ask for a new one, and answers 429 once the password is locked', async () => {
      const { mail } = codeMail();
      const authService = new AuthService(memoryDatabase(), { mail });
      const withTwoFactor = someone('user-16', { passwordHash: await hashPassword('the-real-password-1') });
      await authService.sendCode(withTwoFactor, 'confirm');
      expect(await authService.confirmProblem(withTwoFactor, { code: '000000' }, undefined)).toEqual({ status: 403, error: 'That code is not the one we sent, or it has expired; ask for a new one' });
      const withPassword = someone('user-17', { twoFactorEnabled: false, passwordHash: await hashPassword('the-real-password-1') });
      const quiet = new AuthService(memoryDatabase());
      for (let n = 0; n < 10; n += 1) await quiet.confirmProblem(withPassword, { password: 'not-it-at-all-1' }, undefined);
      expect(await quiet.confirmProblem(withPassword, { password: 'the-real-password-1' }, undefined)).toMatchObject({ status: 429 });
    });

    it('answers 429 when a code is tried while codes are locked', async () => {
      const { mail } = codeMail();
      const authService = new AuthService(memoryDatabase(), { mail });
      const user = someone('user-18', { passwordHash: await hashPassword('the-real-password-1') });
      for (let n = 0; n < 5; n += 1) await authService.checkCode(user.id, 'confirm', '000000');
      expect(await authService.confirmProblem(user, { code: '123456' }, undefined)).toMatchObject({ status: 429 });
    });

    it('asks the current password to change it, and a code as well with two-factor on', async () => {
      const { sent, mail } = codeMail();
      const authService = new AuthService(memoryDatabase(), { mail });
      const user = someone('user-11', { passwordHash: await hashPassword('the-real-password-1') });
      expect(await authService.passwordChangeProblem(user, {}, undefined)).toEqual({ status: 403, error: 'Enter your current password to change it' });
      expect(await authService.passwordChangeProblem(user, { current: 'wrong-password-12' }, undefined)).toEqual({ status: 403, error: 'That is not your current password' });
      expect((await authService.passwordChangeProblem(user, { current: 'the-real-password-1' }, undefined))?.error).toContain('two-factor');
      await authService.sendCode(user, 'confirm');
      expect(await authService.passwordChangeProblem(user, { current: 'the-real-password-1', code: sent[0]! }, undefined)).toBeUndefined();
    });

    it('asks only the current password to change one when two-factor is off', async () => {
      const authService = new AuthService(memoryDatabase());
      const user = someone('user-19', { twoFactorEnabled: false, passwordHash: await hashPassword('the-real-password-1') });
      expect(await authService.passwordChangeProblem(user, { current: 'the-real-password-1' }, undefined)).toBeUndefined();
    });
  });

  describe('sending sign-in codes', () => {
    const person = someone('user-5', { email: 'five@example.com' });

    it('logs the code for the developer when the server sends no email', async () => {
      const authService = new AuthService(memoryDatabase());
      const spy = vi.spyOn(authService['logger'], 'warn');
      await authService.send2FACode(someone('user-4', { email: 'test@example.com' }), '999999');
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('[DEVELOPER 2FA ALERT]'));
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('test@example.com'));
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('999999'));
    });

    it('emails the code where the server sends email, and logs nothing of it', async () => {
      const toAddress = vi.fn(async (_to: string, _message: { subject: string; text: string }) => undefined);
      const authService = new AuthService(memoryDatabase(), { mail: { available: () => ({ ok: true as const }), toAddress }, production: true });
      const warn = vi.spyOn(authService['logger'], 'warn');
      await authService.send2FACode(person, '424242');
      expect(toAddress.mock.calls.map(([to]) => to)).toEqual(['five@example.com']);
      expect(toAddress.mock.calls[0]?.[1].text).toContain('424242');
      expect(warn).not.toHaveBeenCalled();
    });

    it('never logs a code in production, and will not switch on a way it cannot send', async () => {
      const authService = new AuthService(memoryDatabase(), { mail: unavailable('MAIL_SMTP_URL is not set'), production: true });
      const warn = vi.spyOn(authService['logger'], 'warn');
      await expect(authService.send2FACode(person, '424242')).rejects.toThrow('a sign-in code cannot be sent by email to five@example.com, since MAIL_SMTP_URL is not set');
      expect(warn).not.toHaveBeenCalled();
      expect(authService.sendingProblem('email')).toBe('sign-in codes by email need this server to send email, and MAIL_SMTP_URL is not set');
      expect(authService.sendingProblem('sms')).toContain('need Twilio');
      expect(new AuthService(memoryDatabase()).sendingProblem('email')).toBeUndefined();
    });

    it('says a server with no mail at all sends none', () => {
      expect(new AuthService(memoryDatabase(), { production: true }).sendingProblem('email')).toBe('sign-in codes by email need this server to send email, and it sends none');
    });

    describe('by SMS', () => {
      const texted = someone('user-20', { twoFactorPreferredMethod: 'sms', twoFactorPhone: '+15550100' });

      beforeEach(() => {
        vi.mocked(https.request).mockReset();
      });

      const twilio = { accountSid: 'AC123', authToken: 'token', phoneNumber: '+15550199' };

      it('sends the code through Twilio, signed in as the account', async () => {
        const requests = twilioAnswers(201, '{}');
        await new AuthService(memoryDatabase(), { twilio }).send2FACode(texted, '123456');
        expect(requests).toHaveLength(1);
        expect(requests[0]?.options).toMatchObject({ hostname: 'api.twilio.com', path: '/2010-04-01/Accounts/AC123/Messages.json', method: 'POST' });
        expect((requests[0]?.options.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('AC123:token').toString('base64')}`);
        const sent = new URLSearchParams(requests[0]?.written.join(''));
        expect(sent.get('To')).toBe('+15550100');
        expect(sent.get('From')).toBe('+15550199');
        expect(sent.get('Body')).toBe('Your Koala sign-in code is: 123456');
      });

      it('words a confirmation code as one', async () => {
        const requests = twilioAnswers(201, '{}');
        await new AuthService(memoryDatabase(), { twilio }).send2FACode(texted, '654321', 'confirm');
        expect(new URLSearchParams(requests[0]?.written.join('')).get('Body')).toBe('Your Koala confirmation code is: 654321');
      });

      it('fails with what Twilio said when it refuses', async () => {
        twilioAnswers(401, 'bad credentials');
        await expect(new AuthService(memoryDatabase(), { twilio }).send2FACode(texted, '123456')).rejects.toThrow('Twilio API responded with status 401: bad credentials');
      });

      it('fails when the request itself fails', async () => {
        vi.mocked(https.request).mockImplementation((() => {
          const req = Object.assign(new EventEmitter(), { write: vi.fn(), end: () => queueMicrotask(() => req.emit('error', new Error('socket hang up'))) });
          return req;
        }) as never);
        await expect(new AuthService(memoryDatabase(), { twilio }).send2FACode(texted, '123456')).rejects.toThrow('socket hang up');
      });

      it('shows the code to the developer when Twilio is not set up, and refuses in production', async () => {
        const authService = new AuthService(memoryDatabase());
        const warn = vi.spyOn(authService['logger'], 'warn');
        await authService.send2FACode(texted, '123456');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('by SMS to +15550100'));
        await expect(new AuthService(memoryDatabase(), { production: true }).send2FACode(texted, '123456')).rejects.toThrow('a sign-in code cannot be sent by SMS to +15550100, since Twilio is not set up');
      });

      it('fails when the account has no phone number', async () => {
        await expect(new AuthService(memoryDatabase()).send2FACode(someone('user-21', { twoFactorPreferredMethod: 'sms' }), '123456')).rejects.toThrow('no phone number');
      });

      it('says in production whether Twilio is set up for SMS', () => {
        const authService = new AuthService(memoryDatabase(), { production: true });
        expect(authService.sendingProblem('sms')).toBe('sign-in codes by SMS need Twilio, which this server does not have set up');
        expect(new AuthService(memoryDatabase(), { production: true, twilio }).sendingProblem('sms')).toBeUndefined();
        expect(new AuthService(memoryDatabase()).sendingProblem('sms')).toBeUndefined();
      });
    });
  });

  describe('sign-up codes', () => {
    it('emails a sign-up code where the server sends email, and logs nothing of it', async () => {
      const toAddress = vi.fn(async (_to: string, _message: { subject: string; text: string }) => undefined);
      const authService = new AuthService(memoryDatabase(), { mail: { available: () => ({ ok: true as const }), toAddress }, production: true });
      const warn = vi.spyOn(authService['logger'], 'warn');
      expect(await authService.sendSignUpCode('new@example.com', '135790')).toEqual({ kind: 'sent' });
      expect(toAddress.mock.calls.map(([to, message]) => [to, message.subject])).toEqual([['new@example.com', 'Your Koala sign-up code']]);
      expect(toAddress.mock.calls[0]?.[1].text).toContain('135790');
      expect(warn).not.toHaveBeenCalled();
    });

    it('refuses a sign-up in production when no email can be sent, never logging or handing back its code', async () => {
      const authService = new AuthService(memoryDatabase(), { mail: unavailable('MAIL_SMTP_URL is not set'), production: true });
      const warn = vi.spyOn(authService['logger'], 'warn');
      const answer = await authService.sendSignUpCode('new@example.com', '135790');
      expect(answer).toEqual({ kind: 'refused', why: 'This server cannot send email yet (MAIL_SMTP_URL is not set), so it cannot confirm your address; ask whoever runs it' });
      expect(JSON.stringify(answer)).not.toContain('135790');
      expect(warn).not.toHaveBeenCalled();
    });

    it('shows a sign-up code to the developer outside production when no email can be sent', async () => {
      const authService = new AuthService(memoryDatabase());
      const warn = vi.spyOn(authService['logger'], 'warn');
      expect(await authService.sendSignUpCode('new@example.com', '135790')).toEqual({ kind: 'shown', code: '135790' });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('new@example.com'));
    });

    it('says how a code would reach a person', () => {
      expect(new AuthService(memoryDatabase()).codeDelivery()).toEqual({ kind: 'shown' });
      expect(new AuthService(memoryDatabase(), { production: true }).codeDelivery()).toEqual({ kind: 'refused', why: 'This server cannot send email yet (it sends none), so it cannot send you a code; ask whoever runs it' });
      const refused = new AuthService(memoryDatabase(), { mail: unavailable('no relay'), production: true }).codeDelivery();
      expect(refused.kind === 'refused' ? refused.why : '').toContain('no relay');
      expect(new AuthService(memoryDatabase(), { mail: codeMail().mail, production: true }).codeDelivery()).toEqual({ kind: 'mail' });
    });

    it('mails in the background, saying so in the log when it does not arrive', async () => {
      const authService = new AuthService(memoryDatabase(), { mail: { available: () => ({ ok: true as const }), toAddress: async () => { throw new Error('smtp down'); } } });
      const warn = vi.spyOn(authService['logger'], 'warn');
      authService.mailInBackground('ann@example.com', { subject: 'Hello', text: 'x' });
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[AuthService] "Hello" did not reach ann@example.com: smtp down'));
      expect(() => new AuthService(memoryDatabase()).mailInBackground('ann@example.com', { subject: 'Hello', text: 'x' })).not.toThrow();
    });
  });

  it('sends an account at most five confirmation codes in fifteen minutes, counted in the store', async () => {
    const db = memoryDatabase();
    const { mail } = codeMail();
    const clock = Date.now();
    const authService = new AuthService(db, { mail, now: () => clock });
    const user = someone('user-12');
    for (let n = 0; n < 5; n += 1) expect(await authService.sendConfirmCode(user)).toEqual({ kind: 'sent' });
    const limited = await authService.sendConfirmCode(user);
    expect(limited.kind).toBe('limited');
    expect(limited.kind === 'limited' ? limited.said : '').toContain('5 confirmation codes in the last 15 minutes');
    expect(await new AuthService(db, { mail, now: () => clock + 60_000 }).sendConfirmCode(user)).toMatchObject({ kind: 'limited' });
    expect(mail.toAddress).toHaveBeenCalledTimes(5);
    expect(await new AuthService(db, { mail, now: () => clock + 15 * 60_000 + 1 }).sendConfirmCode(user)).toEqual({ kind: 'sent' });
  });

  it('refuses a confirmation code while the account\'s codes are locked', async () => {
    const authService = new AuthService(memoryDatabase(), { mail: codeMail().mail });
    const user = someone('user-22');
    for (let n = 0; n < 5; n += 1) await authService.checkCode(user.id, 'confirm', '000000');
    expect(await authService.sendConfirmCode(user)).toMatchObject({ kind: 'locked' });
  });

  describe('signing in with a provider', () => {
    const person = { provider: 'Google', issuer: 'https://accounts.google.com', subject: 'sub-1', email: 'new@example.com', verified: true };
    const accept = async () => null;

    it('makes an account for someone new whose invite is accepted, the first of them an operator', async () => {
      const db = memoryDatabase();
      const authService = new AuthService(db);
      const consume = vi.fn(accept);
      const first = await authService.signInWithProvider(person, 'invite-1', consume);
      expect(first).toMatchObject({ kind: 'signed-in', user: { email: 'new@example.com', roles: ['operator'], emailVerified: true, signInLinks: [{ issuer: person.issuer, subject: 'sub-1' }] } });
      expect(consume).toHaveBeenCalledWith('invite-1', expect.any(String), true, 'new@example.com');
      expect((await db.accounts.getUsers()).map((user) => user.email)).toEqual(['new@example.com']);
      const second = await authService.signInWithProvider({ ...person, subject: 'sub-2', email: 'second@example.com' }, 'invite-2', consume);
      expect(second.kind === 'signed-in' ? second.user.roles : 'refused').toBeUndefined();
      expect(consume).toHaveBeenLastCalledWith('invite-2', expect.any(String), false, 'second@example.com');
    });

    it('makes no account when the invite is refused', async () => {
      const db = memoryDatabase();
      const answer = await new AuthService(db).signInWithProvider(person, undefined, async () => 'You need an invite');
      expect(answer).toEqual({ kind: 'refused', why: 'You need an invite' });
      expect(await db.accounts.getUsers()).toEqual([]);
    });

    it('signs in the account linked to the subject, and refuses what the match refuses', async () => {
      const db = memoryDatabase();
      await db.accounts.saveUser(someone('linked', { email: 'linked@example.com', twoFactorEnabled: false, signInLinks: [{ issuer: person.issuer, subject: 'sub-1' }] }));
      const authService = new AuthService(db);
      expect(await authService.signInWithProvider(person, undefined, accept)).toMatchObject({ kind: 'signed-in', user: { id: 'linked' } });
      const refused = await authService.signInWithProvider({ ...person, subject: 'sub-9', verified: false }, undefined, accept);
      expect(refused.kind === 'refused' ? refused.why : '').toContain('does not say new@example.com is verified');
    });

    it('joins an existing account by its confirmed address, remembering the link', async () => {
      const db = memoryDatabase();
      await db.accounts.saveUser(someone('ann', { email: 'new@example.com', twoFactorEnabled: false }));
      const answer = await new AuthService(db).signInWithProvider(person, undefined, accept);
      expect(answer).toMatchObject({ kind: 'signed-in', user: { id: 'ann' } });
      expect((await db.accounts.getUserById('ann'))?.signInLinks).toEqual([{ issuer: person.issuer, subject: 'sub-1' }]);
    });

    it('refuses an account being removed', async () => {
      const db = memoryDatabase();
      await db.accounts.saveUser(someone('gone', { twoFactorEnabled: false, signInLinks: [{ issuer: person.issuer, subject: 'sub-1' }], removal: { startedAt: 't', workflowId: 'w' } as never }));
      expect(await new AuthService(db).signInWithProvider(person, undefined, accept)).toEqual({ kind: 'refused', why: 'This account is being removed' });
    });

    it('asks for the second factor of an account that has one, sending the code', async () => {
      const db = memoryDatabase();
      await db.accounts.saveUser(someone('ann', { email: 'new@example.com', signInLinks: [{ issuer: person.issuer, subject: 'sub-1' }] }));
      const { sent, mail } = codeMail();
      const answer = await new AuthService(db, { mail }).signInWithProvider(person, undefined, accept);
      expect(answer).toMatchObject({ kind: 'second-factor', user: { id: 'ann' } });
      expect(sent).toHaveLength(1);
      expect(mail.toAddress).toHaveBeenCalledWith('new@example.com', expect.objectContaining({ subject: 'Your Koala sign-in code' }));
    });

    it('refuses with why when the account\'s codes are locked', async () => {
      const db = memoryDatabase();
      await db.accounts.saveUser(someone('ann', { email: 'new@example.com', signInLinks: [{ issuer: person.issuer, subject: 'sub-1' }] }));
      const authService = new AuthService(db, { mail: codeMail().mail });
      for (let n = 0; n < 5; n += 1) await authService.checkCode('ann', 'sign-in', '000000');
      const locked = await authService.signInWithProvider(person, undefined, accept);
      expect(locked.kind === 'refused' ? locked.why : '').toContain('15 minutes');
    });
  });
});
