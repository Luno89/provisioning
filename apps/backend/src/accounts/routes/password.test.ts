import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { verifyJWT } from '../../platform/lib/auth.js';
import type { Auth } from '../../platform/middleware/auth.js';
import type { UserMetadata } from '../../platform/lib/types.js';
import { callRouter, PERSON } from '../testing/call-router.js';
import type { PasswordService } from '../services/PasswordService.js';
import { passwordRouter } from './password.js';
import type { Devices } from './device.js';

const KEY = 'test-secret';

function set(passwords = mock<PasswordService>()) {
  const auth = mock<Auth>();
  const devices = mock<Devices>();
  return { passwords, auth, devices, router: passwordRouter({ passwords, auth, devices, sessionKey: KEY }) };
}

describe('/api/auth/password', () => {
  it('starts a reset for the address given, handing back the reset and, in development, its code', async () => {
    const { passwords, router } = set();
    passwords.forgot.mockResolvedValue({ ok: true, reset: 'r1', devCode: '123456' });
    const answer = await callRouter(router, '/api/auth/password', { method: 'POST', path: '/forgot', body: { email: 'ann@example.com' }, user: null });
    expect(answer.body).toEqual({ reset: 'r1', devCode: '123456' });
    expect(passwords.forgot).toHaveBeenCalledWith('ann@example.com');
  });

  it('hands back no code when none is shown', async () => {
    const { passwords, router } = set();
    passwords.forgot.mockResolvedValue({ ok: true, reset: 'r1' });
    expect((await callRouter(router, '/api/auth/password', { method: 'POST', path: '/forgot', body: { email: 'ann@example.com' }, user: null })).body).toEqual({ reset: 'r1' });
  });

  it('says why a reset cannot start, with the status the service gave', async () => {
    const { passwords, router } = set();
    passwords.forgot.mockResolvedValue({ ok: false, status: 400, error: 'Enter a valid email address' });
    const answer = await callRouter(router, '/api/auth/password', { method: 'POST', path: '/forgot', body: {}, user: null });
    expect(answer.status).toBe(400);
    expect(answer.body).toEqual({ error: 'Enter a valid email address' });
  });

  it('sends the reset\'s code again', async () => {
    const { passwords, router } = set();
    passwords.resend.mockResolvedValue({ ok: true, reset: 'r1' });
    expect((await callRouter(router, '/api/auth/password', { method: 'POST', path: '/forgot/resend', body: { id: 'r1' }, user: null })).body).toEqual({ reset: 'r1' });
    expect(passwords.resend).toHaveBeenCalledWith('r1');
    passwords.resend.mockResolvedValue({ ok: false, status: 410, error: 'This password reset has ended; ask for a new one' });
    expect((await callRouter(router, '/api/auth/password', { method: 'POST', path: '/forgot/resend', body: { id: 'gone' }, user: null })).status).toBe(410);
  });

  it('resets the password with the code, answering with the address it was for', async () => {
    const { passwords, router } = set();
    passwords.reset.mockResolvedValue({ ok: true, email: 'ann@example.com' });
    const answer = await callRouter(router, '/api/auth/password', { method: 'POST', path: '/reset', body: { id: 'r1', code: '123456', password: 'a-long-new-password' }, user: null });
    expect(answer.body).toEqual({ reset: true, email: 'ann@example.com' });
    expect(passwords.reset).toHaveBeenCalledWith({ id: 'r1', code: '123456', password: 'a-long-new-password' });
    passwords.reset.mockResolvedValue({ ok: false, status: 401, error: 'That code is not the one we sent; check the email and try again' });
    expect((await callRouter(router, '/api/auth/password', { method: 'POST', path: '/reset', body: {}, user: null })).status).toBe(401);
  });

  it('refuses a change from nobody signed in', async () => {
    const { passwords, router } = set();
    const answer = await callRouter(router, '/api/auth/password', { method: 'POST', path: '/', body: { password: 'x' }, user: null });
    expect(answer.status).toBe(401);
    expect(answer.body).toEqual({ error: 'Sign in first' });
    expect(passwords.change).not.toHaveBeenCalled();
  });

  it('changes the password for the person signed in and gives their browser a new session', async () => {
    const { passwords, auth, devices, router } = set();
    const changed = { ...PERSON, sessionsEndedAt: 'now' } as UserMetadata;
    const device = { account: PERSON.email, id: 'phone' };
    devices.known.mockReturnValue(device);
    passwords.change.mockResolvedValue({ ok: true, user: changed });
    auth.setSessionCookie.mockImplementation(() => undefined);
    const answer = await callRouter(router, '/api/auth/password', { method: 'POST', path: '/', body: { password: 'the-new-one-1', current: 'the-old-one-1', code: '123456' } });
    expect(answer.body).toEqual({ changed: true });
    expect(passwords.change).toHaveBeenCalledWith(expect.objectContaining({ id: PERSON.id }), { password: 'the-new-one-1', current: 'the-old-one-1', code: '123456' }, device, undefined);
    const [, token] = auth.setSessionCookie.mock.calls[0] ?? [];
    expect(verifyJWT(token as string, 'session', KEY)).toMatchObject({ userId: PERSON.id });
  });

  it('keeps the session as it was and says why when the change is refused', async () => {
    const { passwords, auth, router } = set();
    passwords.change.mockResolvedValue({ ok: false, status: 403, error: 'Enter your current password to change it' });
    const answer = await callRouter(router, '/api/auth/password', { method: 'POST', path: '/', body: { password: 'the-new-one-1' } });
    expect(answer.status).toBe(403);
    expect(answer.body).toEqual({ error: 'Enter your current password to change it' });
    expect(auth.setSessionCookie).not.toHaveBeenCalled();
  });
});
