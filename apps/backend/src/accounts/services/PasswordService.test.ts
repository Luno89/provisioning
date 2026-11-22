import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { passwordMatches } from '../../platform/lib/auth.js';
import type { AccessRevoked } from '../../platform/lib/revocations.js';
import type { UserMetadata } from '../../platform/lib/types.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { breachedFrom } from '../lib/passwords.js';
import { RESET_CODES_SENT, RESET_WRONG_CODES } from '../lib/password-reset.js';
import { codeHash } from '../lib/codes.js';

const CODE_KEY = 'the-data-key-codes-are-kept-with';
import type { AuthService } from './AuthService.js';
import { PasswordService } from './PasswordService.js';

const NOW = new Date('2026-11-02T12:00:00.000Z');
const KEPT = { session: 'the-session-the-change-was-made-in', rootSid: 'its-session-at-root' };

type Auth = Pick<AuthService, 'codeDelivery' | 'mailInBackground' | 'passwordChangeProblem' | 'forgetPasswordFailures'>;

function set(delivery: ReturnType<AuthService['codeDelivery']> = { kind: 'mail' }, now = () => NOW) {
  const db = memoryDatabase();
  const auth = mock<Auth>();
  auth.codeDelivery.mockReturnValue(delivery);
  const revoked: AccessRevoked[] = [];
  const service = new PasswordService({ db, codeKey: CODE_KEY, auth, breached: breachedFrom('password1234\n'), revocations: { revoked: async (event) => { revoked.push(event); return []; } }, now });
  const mailed = () => auth.mailInBackground.mock.calls.map(([to, message]) => ({ to, subject: message.subject, code: /\b(\d{6})\b/.exec(message.text)?.[1] }));
  return { db, auth, service, revoked, mailed };
}

const ann = (extra: Partial<UserMetadata> = {}): UserMetadata => ({ id: 'ann', email: 'ann@example.com', passwordHash: 'old', twoFactorEnabled: false, emailVerified: true, createdAt: 't', ...extra });

describe('choosing a new password', () => {
  it('refuses a short, leaked or personal password, and says nothing of a good one', () => {
    const { service } = set();
    expect(service.newPasswordProblem('short')).toMatch(/12/);
    expect(service.newPasswordProblem('password1234')).toMatch(/leaked|known|common/i);
    expect(service.newPasswordProblem('Ann@Example.com', 'ann@example.com')).toBe('Your password cannot be your email address');
    expect(service.newPasswordProblem('a-long-unusual-passphrase')).toBeUndefined();
    expect(service.newPasswordProblem(12345)).toBeDefined();
  });
});

describe('forgetting a password', () => {
  it('refuses what is not an email address', async () => {
    const { service } = set();
    expect(await service.forgot('no-at-sign')).toEqual({ ok: false, status: 400, error: 'That is not an email address; check it and try again' });
    expect(await service.forgot(undefined)).toMatchObject({ ok: false, status: 400 });
  });

  it('mails a code that is kept only as a hash to the address of an account', async () => {
    const { db, service, mailed } = set();
    await db.accounts.saveUser(ann());
    const answer = await service.forgot(' Ann@Example.com ');
    expect(answer).toMatchObject({ ok: true });
    expect('devCode' in answer).toBe(false);
    const { to, subject, code } = mailed()[0]!;
    expect({ to, subject }).toEqual({ to: 'ann@example.com', subject: 'Your Koala password reset code' });
    const id = (answer as { reset: string }).reset;
    const kept = await db.accounts.getPasswordReset(id);
    expect(kept).toMatchObject({ ownerId: 'ann', email: 'ann@example.com', wrong: 0, sent: 1, codeHash: codeHash(CODE_KEY, id, code!), expiresAt: new Date(NOW.getTime() + 30 * 60_000) });
    expect(JSON.stringify(kept)).not.toContain(code);
  });

  it('answers an address with no account alike and mails nothing, keeping a code that matches nothing', async () => {
    const { db, service, mailed } = set();
    const answer = await service.forgot('nobody@example.com');
    expect(answer).toMatchObject({ ok: true });
    expect(mailed()).toEqual([]);
    const kept = await db.accounts.getPasswordReset((answer as { reset: string }).reset);
    expect(kept?.ownerId).toBeUndefined();
    expect(kept?.email).toBe('nobody@example.com');
  });

  it('treats an account being removed as none', async () => {
    const { db, service, mailed } = set();
    await db.accounts.saveUser(ann({ removal: { startedAt: 't', requestedBy: 'ann' } }));
    const answer = await service.forgot('ann@example.com');
    expect((await db.accounts.getPasswordReset((answer as { reset: string }).reset))?.ownerId).toBeUndefined();
    expect(mailed()).toEqual([]);
  });

  it('hands the code back to the developer where none can be emailed, and only for an account', async () => {
    const { db, service } = set({ kind: 'shown' });
    await db.accounts.saveUser(ann());
    const known = await service.forgot('ann@example.com');
    expect(known).toMatchObject({ ok: true });
    expect((known as { devCode: string }).devCode).toMatch(/^\d{6}$/);
    const unknown = await service.forgot('nobody@example.com');
    expect('devCode' in unknown).toBe(false);
  });

  it('says so when this server cannot send email', async () => {
    const { db, service } = set({ kind: 'refused', why: 'This server cannot send email yet' });
    await db.accounts.saveUser(ann());
    expect(await service.forgot('ann@example.com')).toEqual({ ok: false, status: 503, error: 'This server cannot send email yet' });
  });
});

describe('asking for a reset\'s code again', () => {
  it('sends a new code that replaces the last, a few times at most', async () => {
    const { db, service, mailed } = set();
    await db.accounts.saveUser(ann());
    const { reset: id } = (await service.forgot('ann@example.com')) as { reset: string };
    for (let n = 1; n < RESET_CODES_SENT; n += 1) expect(await service.resend(id)).toEqual({ ok: true, reset: id });
    const last = mailed().at(-1)!;
    expect((await db.accounts.getPasswordReset(id))?.codeHash).toBe(codeHash(CODE_KEY, id, last.code!));
    expect(await service.resend(id)).toEqual({ ok: false, status: 429, error: 'We have sent this reset enough codes; ask for a new one' });
  });

  it('sends nothing for an address with no account, and answers alike', async () => {
    const { service, mailed } = set();
    const { reset: id } = (await service.forgot('nobody@example.com')) as { reset: string };
    expect(await service.resend(id)).toEqual({ ok: true, reset: id });
    expect(mailed()).toEqual([]);
  });

  it('says a reset that is not there, or has expired, has ended', async () => {
    let clock = NOW;
    const { db, service } = set({ kind: 'mail' }, () => clock);
    const gone = { ok: false, status: 410, error: 'This password reset has ended; ask for a new one' };
    expect(await service.resend('no-such')).toEqual(gone);
    expect(await service.resend(undefined)).toEqual(gone);
    expect(await service.resend('')).toEqual(gone);
    await db.accounts.saveUser(ann());
    const { reset: id } = (await service.forgot('ann@example.com')) as { reset: string };
    clock = new Date(NOW.getTime() + 31 * 60_000);
    expect(await service.resend(id)).toEqual(gone);
  });

  it('shows the new code to the developer where none can be emailed', async () => {
    const { db, service } = set({ kind: 'shown' });
    await db.accounts.saveUser(ann());
    const { reset: id } = (await service.forgot('ann@example.com')) as { reset: string };
    const resent = await service.resend(id);
    expect(resent).toMatchObject({ ok: true, reset: id });
    expect((resent as { devCode: string }).devCode).toMatch(/^\d{6}$/);
  });

  it('says so when this server cannot send email', async () => {
    const { db, auth, service } = set();
    await db.accounts.saveUser(ann());
    const { reset: id } = (await service.forgot('ann@example.com')) as { reset: string };
    auth.codeDelivery.mockReturnValue({ kind: 'refused', why: 'no email here' });
    expect(await service.resend(id)).toEqual({ ok: false, status: 503, error: 'no email here' });
  });
});

describe('resetting a password with the emailed code', () => {
  const GOOD = 'a-long-unusual-passphrase';

  async function pending(s: ReturnType<typeof set>) {
    await s.db.accounts.saveUser(ann());
    const { reset: id } = (await s.service.forgot('ann@example.com')) as { reset: string };
    return { id, code: s.mailed().at(-1)!.code! };
  }

  it('replaces the password, ends every session, tells the others, clears the wrong-password count and spends the reset', async () => {
    const s = set();
    const { id, code } = await pending(s);
    expect(await s.service.reset({ id, code: ` ${code} `, password: GOOD })).toEqual({ ok: true, email: 'ann@example.com' });
    const saved = await s.db.accounts.getUserById('ann');
    expect(await passwordMatches(GOOD, saved?.passwordHash)).toBe(true);
    expect(s.revoked).toEqual([{ personId: 'ann', because: 'password-or-2fa', at: NOW.toISOString() }]);
    expect(s.auth.forgetPasswordFailures).toHaveBeenCalledWith('ann@example.com');
    expect(await s.db.accounts.getPasswordReset(id)).toBeUndefined();
    expect((await s.service.reset({ id, code, password: GOOD })).ok).toBe(false);
  });

  it('asks for the six digits', async () => {
    const { service } = set();
    const asked = { ok: false, status: 400, error: 'Enter the six digits from the email' };
    expect(await service.reset({ id: 'x', code: 'abc', password: GOOD })).toEqual(asked);
    expect(await service.reset({ id: 'x', code: 123456, password: GOOD })).toEqual(asked);
  });

  it('says a reset that is not there has ended', async () => {
    const { service } = set();
    const gone = { ok: false, status: 410, error: 'This password reset has ended; ask for a new one' };
    expect(await service.reset({ id: 'no-such', code: '123456', password: GOOD })).toEqual(gone);
    expect(await service.reset({ id: undefined, code: '123456', password: GOOD })).toEqual(gone);
  });

  it('refuses a weak new password before it counts the code', async () => {
    const s = set();
    const { id, code } = await pending(s);
    expect(await s.service.reset({ id, code, password: 'short' })).toMatchObject({ ok: false, status: 400 });
    expect((await s.db.accounts.getPasswordReset(id))?.wrong).toBe(0);
  });

  it('refuses a wrong code, and ends the reset after five', async () => {
    const s = set();
    const { id, code } = await pending(s);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let n = 1; n < RESET_WRONG_CODES; n += 1) {
      expect(await s.service.reset({ id, code: wrong, password: GOOD })).toEqual({ ok: false, status: 401, error: 'That code is not the one we sent; check the email and try again' });
    }
    expect(await s.service.reset({ id, code: wrong, password: GOOD })).toEqual({ ok: false, status: 410, error: 'That code was wrong too many times; ask for a new reset' });
    expect((await s.service.reset({ id, code, password: GOOD })).ok).toBe(false);
    expect(await passwordMatches(GOOD, (await s.db.accounts.getUserById('ann'))?.passwordHash)).toBe(false);
  });

  it('takes no code for an address with no account', async () => {
    const s = set();
    const { reset: id } = (await s.service.forgot('nobody@example.com')) as { reset: string };
    for (const guess of ['000000', '123456']) expect(await s.service.reset({ id, code: guess, password: GOOD })).toMatchObject({ ok: false, status: 401 });
  });

  it('refuses once the account is being removed or gone', async () => {
    const s = set();
    const { id, code } = await pending(s);
    await s.db.accounts.saveUser(ann({ removal: { startedAt: 't', requestedBy: 'ann' } }));
    expect(await s.service.reset({ id, code, password: GOOD })).toMatchObject({ ok: false, status: 410 });
    expect(s.revoked).toEqual([]);
  });

  it('works without anyone to tell', async () => {
    const db = memoryDatabase();
    const auth = mock<Auth>();
    auth.codeDelivery.mockReturnValue({ kind: 'mail' });
    await db.accounts.saveUser(ann());
    const service = new PasswordService({ db, codeKey: CODE_KEY, auth, breached: breachedFrom('') });
    const { reset: id } = (await service.forgot('ann@example.com')) as { reset: string };
    const code = /\b(\d{6})\b/.exec(auth.mailInBackground.mock.calls[0]![1].text)![1]!;
    expect(await service.reset({ id, code, password: GOOD })).toMatchObject({ ok: true });
  });
});

describe('changing a password while signed in', () => {
  const NEW = 'a-long-unusual-passphrase';

  it('asks the account for the proof it wants and replaces the password once it has it, keeping the browser it was changed in signed in', async () => {
    const s = set();
    await s.db.accounts.saveUser(ann());
    const device = { account: 'ann@example.com', id: 'phone' };
    s.auth.passwordChangeProblem.mockResolvedValue(undefined);
    const answer = await s.service.change(ann(), { password: NEW, current: 'the-old-one', code: ' 123456 ' }, device, KEPT, '198.51.100.4');
    expect(answer).toMatchObject({ ok: true, user: { id: 'ann' } });
    expect(s.revoked).toEqual([{ personId: 'ann', because: 'password-or-2fa', at: NOW.toISOString(), kept: KEPT }]);
    expect(s.auth.passwordChangeProblem).toHaveBeenCalledWith(expect.objectContaining({ id: 'ann' }), { current: 'the-old-one', code: '123456' }, device, '198.51.100.4');
    expect(await passwordMatches(NEW, (await s.db.accounts.getUserById('ann'))?.passwordHash)).toBe(true);
    expect(s.revoked).toEqual([{ personId: 'ann', because: 'password-or-2fa', at: NOW.toISOString(), kept: KEPT }]);
  });

  it('passes on no proof that was not given', async () => {
    const s = set();
    await s.db.accounts.saveUser(ann());
    s.auth.passwordChangeProblem.mockResolvedValue({ status: 403, error: 'Enter your current password to change it' });
    expect(await s.service.change(ann(), { password: NEW, current: '', code: 7 }, undefined, KEPT)).toEqual({ ok: false, status: 403, error: 'Enter your current password to change it' });
    expect(s.auth.passwordChangeProblem).toHaveBeenCalledWith(expect.anything(), {}, undefined, undefined);
    expect(s.revoked).toEqual([]);
    expect((await s.db.accounts.getUserById('ann'))?.passwordHash).toBe('old');
  });

  it('refuses an account that is gone or being removed', async () => {
    const s = set();
    expect(await s.service.change(ann(), { password: NEW, current: 'x', code: undefined }, undefined, KEPT)).toEqual({ ok: false, status: 401, error: 'Sign in first' });
    await s.db.accounts.saveUser(ann({ removal: { startedAt: 't', requestedBy: 'ann' } }));
    expect(await s.service.change(ann(), { password: NEW, current: 'x', code: undefined }, undefined, KEPT)).toMatchObject({ ok: false, status: 401 });
  });

  it('refuses a weak new password before it asks for any proof', async () => {
    const s = set();
    await s.db.accounts.saveUser(ann());
    expect(await s.service.change(ann(), { password: 'short', current: 'x', code: undefined }, undefined, KEPT)).toMatchObject({ ok: false, status: 400 });
    expect(s.auth.passwordChangeProblem).not.toHaveBeenCalled();
  });
});
