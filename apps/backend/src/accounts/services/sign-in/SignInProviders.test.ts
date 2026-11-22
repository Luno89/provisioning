import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { UserMetadata } from '../../../platform/lib/types.js';
import { providerCallbackUrl, type SignInChecks, type SignInClient, type SignInProvider } from '../../lib/sign-in-providers.js';
import type { AuthService } from '../AuthService.js';
import { githubSignIn } from './github.js';
import { oidcSignIn } from './oidc.js';
import { SIGN_IN_CLIENTS, SignInProviders } from './SignInProviders.js';

const PUBLIC = 'https://app.example.test';

const provider = (id: string, kind: SignInProvider['kind'] = 'oidc'): SignInProvider => ({
  id, label: id === 'google' ? 'Google' : 'Your organisation', kind, issuer: `https://${id}.example.test`, scopes: ['openid', 'email'], clientId: 'client', clientSecret: 'secret',
});

function set(providers: SignInProvider[] = [provider('google'), provider('oidc')], returnUrl?: string) {
  const clients = new Map<string, ReturnType<typeof mock<SignInClient>>>();
  const made: string[] = [];
  const accounts = mock<Pick<AuthService, 'signInWithProvider'>>();
  const build = (which: SignInProvider) => {
    made.push(which.id);
    const one = mock<SignInClient>();
    one.authorizationUrl.mockImplementation(async (redirect, checks: SignInChecks) => new URL(`https://${which.id}.example.test/auth?redirect_uri=${encodeURIComponent(redirect)}&state=${checks.state}`));
    clients.set(which.id, one);
    return one;
  };
  const service = new SignInProviders({ providers, publicUrl: PUBLIC, returnUrl, accounts, clients: { oidc: build, github: build } });
  return { service, clients, made, accounts };
}

const consume = async () => null;

describe('which ways to sign in a server offers', () => {
  it('offers each configured provider by id and label', () => {
    expect(set().service.offered()).toEqual([{ id: 'google', label: 'Google' }, { id: 'oidc', label: 'Your organisation' }]);
    expect(set([]).service.offered()).toEqual([]);
  });

  it('builds the client for each kind from the shipped ones', () => {
    expect(SIGN_IN_CLIENTS.oidc).toBe(oidcSignIn);
    expect(SIGN_IN_CLIENTS.github).toBe(githubSignIn);
  });
});

describe('starting a sign-in', () => {
  it('says a provider it does not offer is not there', async () => {
    const { service } = set();
    expect(await service.start('nowhere', '')).toEqual({ kind: 'unknown' });
  });

  it('asks the provider for an address to send the person to, handing back the checks to hold with the sign-in, the invite carried', async () => {
    const { service, clients } = set();
    const started = await service.start('google', 'INVITE');
    expect(started.kind).toBe('started');
    if (started.kind !== 'started') return;
    const url = new URL(started.url);
    expect(url.searchParams.get('redirect_uri')).toBe(providerCallbackUrl(PUBLIC, 'google'));
    const { held } = started;
    expect(held.state).toBe(url.searchParams.get('state'));
    expect(held.invite).toBe('INVITE');
    expect(held.provider).toBe('google');
    expect(held.verifier).toMatch(/^[\w-]{43,}$/);
    expect(held.nonce).toMatch(/^[\w-]{16,}$/);
    const [, checks] = clients.get('google')!.authorizationUrl.mock.calls.at(-1)!;
    expect(checks).toEqual({ state: held.state, verifier: held.verifier, nonce: held.nonce });
  });

  it('makes each provider\'s client once however many times it is used', async () => {
    const { service, made } = set();
    await service.start('google', '');
    await service.start('google', '');
    await service.start('oidc', '');
    expect(made).toEqual(['google', 'oidc']);
  });

  it('says the provider could not be asked, with the most specific reason it gave', async () => {
    const { service, clients } = set();
    await service.start('google', '');
    const client = clients.get('google')!;
    client.authorizationUrl.mockRejectedValueOnce(Object.assign(new Error('x'), { error_description: 'The issuer is down' }));
    expect(await service.start('google', '')).toEqual({ kind: 'refused', why: 'Google could not be asked to sign you in: The issuer is down' });
    client.authorizationUrl.mockRejectedValueOnce(Object.assign(new Error('x'), { error: 'server_error' }));
    expect(await service.start('google', '')).toEqual({ kind: 'refused', why: 'Google could not be asked to sign you in: server_error' });
    client.authorizationUrl.mockRejectedValueOnce(Object.assign(new Error('discovery failed'), { cause: new Error('connect ECONNREFUSED') }));
    expect(await service.start('google', '')).toEqual({ kind: 'refused', why: 'Google could not be asked to sign you in: discovery failed: connect ECONNREFUSED' });
    client.authorizationUrl.mockRejectedValueOnce(Object.assign(new Error('same'), { cause: new Error('same') }));
    expect(await service.start('google', '')).toEqual({ kind: 'refused', why: 'Google could not be asked to sign you in: same' });
    client.authorizationUrl.mockRejectedValueOnce('a bare string');
    expect(await service.start('google', '')).toEqual({ kind: 'refused', why: 'Google could not be asked to sign you in: a bare string' });
  });
});

describe('finishing a sign-in', () => {
  const person = { subject: 'sub-1', email: 'ann@example.com', verified: true };

  async function begun(s: ReturnType<typeof set>, id = 'google', invite = 'INVITE') {
    await s.service.start(id, invite);
    const state = 'a-state-held-with-the-sign-in';
    const cookie = { provider: id, state, verifier: 'a-verifier-of-sufficient-length-for-pkce-123', nonce: 'a-nonce', invite };
    return { state, cookie, callback: new URL(`${PUBLIC}/api/auth/provider/${id}/callback?code=c&state=${state}`) };
  }

  it('says a provider it does not offer is not there', async () => {
    expect(await set().service.finish('nowhere', new URL(PUBLIC), undefined, consume)).toEqual({ kind: 'unknown' });
  });

  it('identifies the person against the checks it held and hands them to the accounts, with the invite carried', async () => {
    const s = set();
    const { state, cookie, callback } = await begun(s);
    s.clients.get('google')!.identify.mockResolvedValue(person);
    const signedIn = { kind: 'signed-in' as const, user: { id: 'ann', email: 'ann@example.com' } as UserMetadata };
    s.accounts.signInWithProvider.mockResolvedValue(signedIn);
    expect(await s.service.finish('google', callback, cookie, consume)).toBe(signedIn);
    expect(s.clients.get('google')!.identify).toHaveBeenCalledWith(callback, { state, verifier: 'a-verifier-of-sufficient-length-for-pkce-123', nonce: 'a-nonce' });
    expect(s.accounts.signInWithProvider).toHaveBeenCalledWith({ provider: 'Google', issuer: 'https://google.example.test', ...person }, 'INVITE', consume);
  });

  it('carries no invite when none was given', async () => {
    const s = set();
    const { cookie, callback } = await begun(s, 'google', '');
    s.clients.get('google')!.identify.mockResolvedValue(person);
    s.accounts.signInWithProvider.mockResolvedValue({ kind: 'refused', why: 'An invite is needed' });
    expect(await s.service.finish('google', callback, cookie, consume)).toEqual({ kind: 'refused', why: 'An invite is needed' });
    expect(s.accounts.signInWithProvider.mock.calls[0]?.[1]).toBeUndefined();
  });

  it('refuses a sign-in that did not start here: nothing held, another state, or another provider\'s', async () => {
    const s = set();
    const { cookie, callback } = await begun(s);
    const notStarted = { kind: 'refused', why: 'This sign-in did not start here, or took longer than an hour; start it again' };
    expect(await s.service.finish('google', callback, undefined, consume)).toEqual(notStarted);
    expect(await s.service.finish('google', new URL(`${PUBLIC}/callback?code=c&state=another`), cookie, consume)).toEqual(notStarted);
    expect(await s.service.finish('google', new URL(`${PUBLIC}/callback?code=c`), cookie, consume)).toEqual(notStarted);
    expect(await s.service.finish('oidc', callback, cookie, consume)).toEqual(notStarted);
    expect(s.clients.get('google')!.identify).not.toHaveBeenCalled();
    expect(s.accounts.signInWithProvider).not.toHaveBeenCalled();
  });

  it('refuses what was held when it has no verifier or nonce', async () => {
    const s = set();
    await s.service.start('google', '');
    const state = 'a-state-held-with-the-sign-in';
    const refused = await s.service.finish('google', new URL(`${PUBLIC}/callback?state=${state}`), { provider: 'google', state, invite: '' }, consume);
    expect(refused).toMatchObject({ kind: 'refused' });
  });

  it('says the provider did not sign the person in, and why, when it refuses', async () => {
    const s = set();
    const { cookie, callback } = await begun(s);
    s.clients.get('google')!.identify.mockRejectedValue(Object.assign(new Error('x'), { error_description: 'The code was already used' }));
    expect(await s.service.finish('google', callback, cookie, consume)).toEqual({ kind: 'refused', why: 'Google did not sign you in: The code was already used' });
    expect(s.accounts.signInWithProvider).not.toHaveBeenCalled();
  });
});

describe('a dev box whose providers send people back to localhost', () => {
  it('names the localhost return to the provider, finishes against it, and sends a return reaching it on to its own name', async () => {
    const { service } = set(undefined, 'http://localhost:5175');
    const started = await service.start('google', '');
    if (started.kind !== 'started') throw new Error(started.kind);
    expect(new URL(started.url).searchParams.get('redirect_uri')).toBe('http://localhost:5175/api/auth/provider/google/callback');
    expect(service.callbackUrl('/api/auth/provider/google/callback?code=c').href).toBe('http://localhost:5175/api/auth/provider/google/callback?code=c');
    expect(service.returnedElsewhere('localhost:5175', '/api/auth/provider/google/callback?code=c')).toBe(`${PUBLIC}/api/auth/provider/google/callback?code=c`);
  });

  it('without one, finishes against its own address and sends nothing on', () => {
    const { service } = set();
    expect(service.callbackUrl('/api/auth/provider/google/callback?code=c').href).toBe(`${PUBLIC}/api/auth/provider/google/callback?code=c`);
    expect(service.returnedElsewhere('localhost:5175', '/x')).toBeUndefined();
  });
});
