import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { verifyJWT } from '../../platform/lib/auth.js';
import type { Auth } from '../../platform/middleware/auth.js';
import type { UserMetadata } from '../../platform/lib/types.js';
import { PERSON, routesInProcess } from '../../platform/testing/routes.js';
import type { PasswordService } from '../services/PasswordService.js';
import { passwordRouter } from './password.js';
import type { Devices } from './device.js';

const KEY = 'test-secret';

async function set(passwords = mock<PasswordService>()) {
  const auth = mock<Auth>();
  const devices = mock<Devices>();
  const routes = await routesInProcess({ prefix: '/api/auth/password', router: () => passwordRouter({ passwords, auth, devices, sessionKey: KEY }), user: PERSON, open: true });
  return { passwords, auth, devices, routes };
}

describe('/api/auth/password', () => {
  it('starts a reset for the address given, handing back the reset and, in development, its code', async () => {
    const { passwords, routes } = await set();
    passwords.forgot.mockResolvedValue({ ok: true, reset: 'r1', devCode: '123456' });
    const answer = await routes.post('/api/auth/password/forgot', { email: 'ann@example.com' }, { user: null });
    expect(answer.data).toEqual({ reset: 'r1', devCode: '123456' });
    expect(passwords.forgot).toHaveBeenCalledWith('ann@example.com');
  });

  it('hands back no code when none is shown', async () => {
    const { passwords, routes } = await set();
    passwords.forgot.mockResolvedValue({ ok: true, reset: 'r1' });
    expect((await routes.post('/api/auth/password/forgot', { email: 'ann@example.com' }, { user: null })).data).toEqual({ reset: 'r1' });
  });

  it('says why a reset cannot start, with the status the service gave', async () => {
    const { passwords, routes } = await set();
    passwords.forgot.mockResolvedValue({ ok: false, status: 400, error: 'Enter a valid email address' });
    const answer = await routes.post('/api/auth/password/forgot', {}, { user: null });
    expect(answer.status).toBe(400);
    expect(answer.data).toEqual({ error: 'Enter a valid email address' });
  });

  it('sends the reset\'s code again', async () => {
    const { passwords, routes } = await set();
    passwords.resend.mockResolvedValue({ ok: true, reset: 'r1' });
    expect((await routes.post('/api/auth/password/forgot/resend', { id: 'r1' }, { user: null })).data).toEqual({ reset: 'r1' });
    expect(passwords.resend).toHaveBeenCalledWith('r1');
    passwords.resend.mockResolvedValue({ ok: false, status: 410, error: 'This password reset has ended; ask for a new one' });
    expect((await routes.post('/api/auth/password/forgot/resend', { id: 'gone' }, { user: null })).status).toBe(410);
  });

  it('resets the password with the code, answering with the address it was for', async () => {
    const { passwords, routes } = await set();
    passwords.reset.mockResolvedValue({ ok: true, email: 'ann@example.com' });
    const answer = await routes.post('/api/auth/password/reset', { id: 'r1', code: '123456', password: 'a-long-new-password' }, { user: null });
    expect(answer.data).toEqual({ reset: true, email: 'ann@example.com' });
    expect(passwords.reset).toHaveBeenCalledWith({ id: 'r1', code: '123456', password: 'a-long-new-password' });
    passwords.reset.mockResolvedValue({ ok: false, status: 401, error: 'That code is not the one we sent; check the email and try again' });
    expect((await routes.post('/api/auth/password/reset', {}, { user: null })).status).toBe(401);
  });

  it('refuses a change from nobody signed in', async () => {
    const { passwords, routes } = await set();
    const answer = await routes.post('/api/auth/password/', { password: 'x' }, { user: null });
    expect(answer.status).toBe(401);
    expect(answer.data).toEqual({ error: 'Sign in first' });
    expect(passwords.change).not.toHaveBeenCalled();
  });

  it('changes the password for the person signed in and gives their browser a new session', async () => {
    const { passwords, auth, devices, routes } = await set();
    const changed = { ...PERSON, sessionsEndedAt: 'now' } as UserMetadata;
    const device = { account: PERSON.email, id: 'phone' };
    devices.known.mockReturnValue(device);
    passwords.change.mockResolvedValue({ ok: true, user: changed });
    auth.setSessionCookie.mockImplementation(() => undefined);
    const answer = await routes.post('/api/auth/password/', { password: 'the-new-one-1', current: 'the-old-one-1', code: '123456' });
    expect(answer.data).toEqual({ changed: true });
    expect(passwords.change).toHaveBeenCalledWith(expect.objectContaining({ id: PERSON.id }), { password: 'the-new-one-1', current: 'the-old-one-1', code: '123456' }, device, '127.0.0.1');
    const [, token] = auth.setSessionCookie.mock.calls[0] ?? [];
    expect(verifyJWT(token as string, 'session', KEY)).toMatchObject({ userId: PERSON.id });
  });

  it('keeps the session as it was and says why when the change is refused', async () => {
    const { passwords, auth, routes } = await set();
    passwords.change.mockResolvedValue({ ok: false, status: 403, error: 'Enter your current password to change it' });
    const answer = await routes.post('/api/auth/password/', { password: 'the-new-one-1' });
    expect(answer.status).toBe(403);
    expect(answer.data).toEqual({ error: 'Enter your current password to change it' });
    expect(auth.setSessionCookie).not.toHaveBeenCalled();
  });
});
