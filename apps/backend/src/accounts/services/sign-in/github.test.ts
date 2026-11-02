import { createHash } from 'node:crypto';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { interceptHttp } from '../../../platform/testing/http.js';
import { SignInRefusal, type SignInChecks, type SignInProvider } from '../../lib/sign-in-providers.js';
import { githubSignIn } from './github.js';

const checks: SignInChecks = { state: 'state-1', verifier: 'a-verifier-of-sufficient-length-for-pkce-123456', nonce: 'unused' };
const REDIRECT = 'https://app.example.test/api/auth/provider/github/callback';

const github: SignInProvider = {
  id: 'github', label: 'GitHub', kind: 'github', issuer: 'https://github.com', scopes: ['user:email'], clientId: 'gh-id', clientSecret: 'gh-secret',
  github: { authorization: 'https://github.example.test/login/oauth/authorize', token: 'https://github.example.test/login/oauth/access_token', api: 'https://api.github.example.test' },
};

const seen: { token?: URLSearchParams; user?: Headers } = {};
let person: { id?: unknown } = { id: 4242 };
let emails: unknown = [{ email: 'Octo@Example.com', primary: true, verified: true }];
let userStatus = 200;

interceptHttp(
  http.post('https://github.example.test/login/oauth/access_token', async ({ request }) => {
    seen.token = new URLSearchParams(await request.text());
    return HttpResponse.json({ access_token: 'tok', token_type: 'bearer', scope: 'user:email' });
  }),
  http.get('https://api.github.example.test/user', ({ request }) => {
    seen.user = request.headers;
    return userStatus === 200 ? HttpResponse.json(person) : new HttpResponse(null, { status: userStatus });
  }),
  http.get('https://api.github.example.test/user/emails', () => HttpResponse.json(emails as object)),
);

const callback = new URL(`${REDIRECT}?code=the-code&state=state-1`);

describe('signing in with GitHub', () => {
  it('sends the person to GitHub with a PKCE challenge of the verifier, the state and the scope', async () => {
    const url = await githubSignIn(github).authorizationUrl(REDIRECT, checks);
    expect(url.origin + url.pathname).toBe('https://github.example.test/login/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'gh-id', response_type: 'code', redirect_uri: REDIRECT, scope: 'user:email', state: 'state-1',
      code_challenge: createHash('sha256').update(checks.verifier).digest('base64url'), code_challenge_method: 'S256',
    });
  });

  it('exchanges the code with the verifier and reads the person and their primary address with the token', async () => {
    const identity = await githubSignIn(github).identify(callback, checks);
    expect(identity).toEqual({ subject: '4242', email: 'octo@example.com', verified: true });
    expect(seen.token?.get('code')).toBe('the-code');
    expect(seen.token?.get('code_verifier')).toBe(checks.verifier);
    expect(seen.user?.get('authorization')).toBe('Bearer tok');
    expect(seen.user?.get('user-agent')).toBe('koala-sign-in');
  });

  it('takes a numeric or text id as the subject, and says whether GitHub verified the address', async () => {
    person = { id: 'u-7' };
    emails = [{ email: 'a@example.com' }, { email: 'b@example.com', primary: true }];
    expect(await githubSignIn(github).identify(callback, checks)).toEqual({ subject: 'u-7', email: 'b@example.com', verified: false });
    person = { id: 4242 };
    emails = [{ email: 'Octo@Example.com', primary: true, verified: true }];
  });

  it('refuses when GitHub names nobody', async () => {
    person = {};
    await expect(githubSignIn(github).identify(callback, checks)).rejects.toThrow(new SignInRefusal('GitHub named nobody'));
    person = { id: 4242 };
  });

  it('refuses when GitHub gives no primary address', async () => {
    emails = [{ email: 'a@example.com', verified: true }];
    await expect(githubSignIn(github).identify(callback, checks)).rejects.toThrow('GitHub gave no primary email address; add one there, or sign in with your password');
    emails = [{ email: 'Octo@Example.com', primary: true, verified: true }];
  });

  it('says what GitHub answered when it will not say who the token is', async () => {
    userStatus = 401;
    await expect(githubSignIn(github).identify(callback, checks)).rejects.toThrow('GitHub answered 401 when asked for /user');
    userStatus = 200;
  });

  it('will not be made without GitHub\'s addresses', () => {
    expect(() => githubSignIn({ ...github, github: undefined })).toThrow("GitHub is GitHub's kind of sign-in but names none of GitHub's addresses");
  });

  it('reaches a GitHub on this machine over plain http', async () => {
    const local: SignInProvider = { ...github, github: { authorization: 'http://127.0.0.1:4545/authorize', token: 'http://127.0.0.1:4545/token', api: 'http://127.0.0.1:4545/api' } };
    const url = await githubSignIn(local).authorizationUrl(REDIRECT, checks);
    expect(url.href.startsWith('http://127.0.0.1:4545/authorize?')).toBe(true);
  });
});
