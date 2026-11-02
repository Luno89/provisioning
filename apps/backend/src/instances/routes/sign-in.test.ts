import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Auth } from '../../platform/index.js';
import { callRouter } from '../testing/call-router.js';
import { signInRouter } from './sign-in.js';
import { SIGN_IN_COOKIE, type RootSignIn } from '../services/RootSignIn.js';
import type { IdentityService } from '../services/IdentityService.js';

type SignIn = Pick<RootSignIn, 'start' | 'callback' | 'backchannel' | 'startCookieSeconds'>;

const prefix = '/api/auth';

function rig(over: { hubUrl?: string | undefined; removalUrl?: string | undefined } = {}) {
  const signIn = mock<SignIn>({ startCookieSeconds: 600 });
  const identity = mock<Pick<IdentityService, 'hubUrl' | 'removalUrl'>>();
  identity.hubUrl.mockReturnValue(over.hubUrl);
  identity.removalUrl.mockReturnValue(over.removalUrl);
  const auth = mock<Pick<Auth, 'setSessionCookie' | 'getCookie' | 'securedFor' | 'sessionCookieOptions'>>({ sessionCookieOptions: { httpOnly: true, sameSite: 'lax' } });
  auth.securedFor.mockReturnValue(false);
  const router = signInRouter({ signIn, identity, auth, publicUrl: 'https://instance.example.com', landing: '/chat' });
  return { signIn, identity, auth, router };
}

describe('signing in on an instance or the hub through root', () => {
  it('points the browser at the instance\'s own start, and at the hub when root has one', async () => {
    expect((await callRouter(rig().router, prefix, { path: '/sign-in', user: null })).body).toEqual({ url: '/api/auth/oidc/start', hub: null });
    expect((await callRouter(rig({ hubUrl: 'https://app.example.com/api/identity/go?to=hub' }).router, prefix, { path: '/sign-in', user: null })).body).toEqual({ url: '/api/auth/oidc/start', hub: 'https://app.example.com/api/identity/go?to=hub' });
  });

  it('points the browser at root for removing an account, or at nothing', async () => {
    expect((await callRouter(rig({ removalUrl: 'https://app.example.com/#/remove-account' }).router, prefix, { path: '/account-removal', user: null })).body).toEqual({ url: 'https://app.example.com/#/remove-account' });
    expect((await callRouter(rig().router, prefix, { path: '/account-removal', user: null })).body).toEqual({ url: null });
  });

  it('sends the person to root, keeping what began the sign-in in a cookie that lasts ten minutes', async () => {
    const { signIn, router } = rig();
    signIn.start.calledWith('/chat').mockResolvedValue({ url: 'https://app.example.com/oidc/auth?x=1', cookie: 'held' });
    const answer = await callRouter(router, prefix, { path: '/oidc/start?next=%2Fchat', user: null });
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
    const answer = await callRouter(router, prefix, { path: '/oidc/callback?code=c&state=s', user: null });
    expect([answer.status, answer.headers.location]).toEqual([302, '/#/projects']);
    expect(signIn.callback).toHaveBeenCalledWith(new URL('https://instance.example.com/api/auth/oidc/callback?code=c&state=s'), 'held');
    expect(auth.setSessionCookie).toHaveBeenCalledWith(expect.anything(), 'session-token', expect.anything());
    expect(String(answer.headers['set-cookie'])).toContain(`${SIGN_IN_COOKIE}=;`);
  });

  it('lands on the instance\'s landing page when the person named none', async () => {
    const { signIn, router } = rig();
    signIn.callback.mockResolvedValue({ ok: true, token: 't', session: {} as never });
    expect((await callRouter(router, prefix, { path: '/oidc/callback', user: null })).headers.location).toBe('/#/chat');
  });

  it('says in a page, with the reason escaped, why root\'s answer was refused', async () => {
    const { signIn, auth, router } = rig();
    signIn.callback.mockResolvedValue({ ok: false, status: 403, error: 'this instance belongs to <someone> else & "more"' });
    const answer = await callRouter(router, prefix, { path: '/oidc/callback', user: null });
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
    const taken = await callRouter(router, prefix, { method: 'POST', path: '/oidc/backchannel-logout', rawBody: 'logout_token=good', headers: { 'content-type': 'application/x-www-form-urlencoded' }, user: null });
    expect([taken.status, taken.headers['cache-control']]).toEqual([200, 'no-store']);
    const refused = await callRouter(router, prefix, { method: 'POST', path: '/oidc/backchannel-logout', rawBody: 'logout_token=bad', headers: { 'content-type': 'application/x-www-form-urlencoded' }, user: null });
    expect([refused.status, refused.body]).toEqual([400, { error: 'invalid_request', error_description: 'that is not a logout token' }]);
  });
});
