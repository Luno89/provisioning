import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Auth } from '../../platform/index.js';
import type { Router } from 'express';
import { routesInProcess } from '../../platform/testing/routes.js';
import { signInRouter } from './sign-in.js';
import { SIGN_IN_COOKIE, type RootSignIn } from '../services/RootSignIn.js';
import type { IdentityService } from '../services/IdentityService.js';

type SignIn = Pick<RootSignIn, 'start' | 'callback' | 'backchannel' | 'startCookieSeconds'>;

const prefix = '/api/auth';
const on = (router: Router) => routesInProcess({ prefix, router: () => router, user: null, open: true });

function rig(over: { removalUrl?: string | undefined } = {}) {
  const signIn = mock<SignIn>({ startCookieSeconds: 600 });
  const identity = mock<Pick<IdentityService, 'removalUrl'>>();
  identity.removalUrl.mockReturnValue(over.removalUrl);
  const auth = mock<Pick<Auth, 'setSessionCookie' | 'getCookie' | 'securedFor' | 'sessionCookieOptions'>>({ sessionCookieOptions: { httpOnly: true, sameSite: 'lax' } });
  auth.securedFor.mockReturnValue(false);
  const router = signInRouter({ signIn, identity, auth, publicUrl: 'https://instance.example.com', landing: '/chat' });
  return { signIn, identity, auth, router };
}

describe('signing in on an instance through root', () => {
  it('points the browser at the instance\'s own start', async () => {
    expect((await (await on(rig().router)).get(`${prefix}/sign-in`)).data).toEqual({ url: '/api/auth/oidc/start' });
  });

  it('points the browser at root for removing an account, or at nothing', async () => {
    expect((await (await on(rig({ removalUrl: 'https://app.example.com/#/remove-account' }).router)).get(`${prefix}/account-removal`)).data).toEqual({ url: 'https://app.example.com/#/remove-account' });
    expect((await (await on(rig().router)).get(`${prefix}/account-removal`)).data).toEqual({ url: null });
  });

  it('sends the person to root, keeping what began the sign-in in a cookie that lasts ten minutes', async () => {
    const { signIn, router } = rig();
    signIn.start.calledWith('/chat').mockResolvedValue({ url: 'https://app.example.com/oidc/auth?x=1', cookie: 'held' });
    const answer = await (await on(router)).get(`${prefix}/oidc/start?next=%2Fchat`);
    expect(answer.status).toBe(302);
    expect(answer.headers.location).toBe('https://app.example.com/oidc/auth?x=1');
    expect(answer.headers['cache-control']).toBe('no-store');
    const cookie = String(answer.headers['set-cookie']);
    expect(cookie).toContain(`${SIGN_IN_COOKIE}=held`);
    expect(cookie).toContain('Max-Age=600');
    expect(cookie).toContain('HttpOnly');
  });

  it('finishes the sign-in with the cookie it set, starts the session and lands where the person was going', async () => {
    const { signIn, auth, router } = rig();
    auth.getCookie.mockReturnValue('held');
    signIn.callback.mockResolvedValue({ ok: true, token: 'session-token', session: {} as never, next: '/projects' });
    const answer = await (await on(router)).get(`${prefix}/oidc/callback?code=c&state=s`);
    expect([answer.status, answer.headers.location]).toEqual([302, '/#/projects']);
    expect(signIn.callback).toHaveBeenCalledWith(new URL('https://instance.example.com/api/auth/oidc/callback?code=c&state=s'), 'held');
    expect(auth.setSessionCookie).toHaveBeenCalledWith(expect.anything(), 'session-token', expect.anything());
    expect(String(answer.headers['set-cookie'])).toContain(`${SIGN_IN_COOKIE}=;`);
  });

  it('lands on the instance\'s landing page when the person named none', async () => {
    const { signIn, router } = rig();
    signIn.callback.mockResolvedValue({ ok: true, token: 't', session: {} as never });
    expect((await (await on(router)).get(`${prefix}/oidc/callback`)).headers.location).toBe('/#/chat');
  });

  it('says in a page, with the reason escaped, why root\'s answer was refused', async () => {
    const { signIn, auth, router } = rig();
    signIn.callback.mockResolvedValue({ ok: false, status: 403, error: 'this instance belongs to <someone> else & "more"' });
    const answer = await (await on(router)).get(`${prefix}/oidc/callback`);
    expect(answer.status).toBe(403);
    expect(String(answer.headers['content-type'])).toContain('text/html');
    expect(answer.text).toContain('Koala could not sign you in: this instance belongs to &#60;someone&#62; else &#38; &#34;more&#34;');
    expect(answer.text).toContain('href="/api/auth/oidc/start"');
    expect(auth.setSessionCookie).not.toHaveBeenCalled();
  });

  it('takes root\'s logout token, and refuses one that is not', async () => {
    const { signIn, router } = rig();
    signIn.backchannel.calledWith('good').mockResolvedValue({ ok: true });
    signIn.backchannel.calledWith('bad').mockResolvedValue({ ok: false, error: 'that is not a logout token' });
    const taken = await (await on(router)).post(`${prefix}/oidc/backchannel-logout`, undefined, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, raw: 'logout_token=good' });
    expect([taken.status, taken.headers['cache-control']]).toEqual([200, 'no-store']);
    const refused = await (await on(router)).post(`${prefix}/oidc/backchannel-logout`, undefined, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, raw: 'logout_token=bad' });
    expect([refused.status, refused.data]).toEqual([400, { error: 'invalid_request', error_description: 'that is not a logout token' }]);
  });
});
