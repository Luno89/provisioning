import { describe, it, expect } from 'vitest';
import { addressProblem, identityFromIdToken, offeredProviders, providerCallbackUrl, SIGN_IN_PROVIDERS, signInProvidersFrom } from './sign-in-providers.js';

describe('the ways to sign in a server offers', () => {
  it('offers nothing when no provider is configured, and never a pretend one', () => {
    expect(signInProvidersFrom({})).toEqual({ providers: [], problems: [] });
  });

  it('offers Google over OpenID Connect at Google\'s own issuer, asking only for openid, email and profile', () => {
    const { providers } = signInProvidersFrom({ GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 'g-secret' });
    expect(providers).toEqual([{ id: 'google', label: 'Google', kind: 'oidc', issuer: 'https://accounts.google.com', scopes: ['openid', 'email', 'profile'], clientId: 'g-id', clientSecret: 'g-secret' }]);
  });

  it('offers GitHub at GitHub\'s addresses, asking only for the email addresses', () => {
    const [github] = signInProvidersFrom({ GITHUB_CLIENT_ID: 'h-id', GITHUB_CLIENT_SECRET: 'h-secret' }).providers;
    expect(github).toMatchObject({ id: 'github', kind: 'github', issuer: 'https://github.com', scopes: ['user:email'], github: { authorization: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', api: 'https://api.github.com' } });
  });

  it('offers an organisation\'s own OpenID provider from its issuer, credentials and label in the environment', () => {
    const { providers } = signInProvidersFrom({ OIDC_ISSUER: 'https://login.example.com/', OIDC_CLIENT_ID: 'o-id', OIDC_CLIENT_SECRET: 'o-secret', OIDC_LABEL: 'Example Co' });
    expect(providers).toEqual([{ id: 'oidc', label: 'Example Co', kind: 'oidc', issuer: 'https://login.example.com', scopes: ['openid', 'email', 'profile'], clientId: 'o-id', clientSecret: 'o-secret' }]);
  });

  it('leaves out a half-configured provider, saying what is missing', () => {
    expect(signInProvidersFrom({ GOOGLE_CLIENT_ID: 'g-id' })).toEqual({ providers: [], problems: ['Google sign-in is off: GOOGLE_CLIENT_SECRET is not set'] });
    expect(signInProvidersFrom({ OIDC_CLIENT_ID: 'o-id', OIDC_CLIENT_SECRET: 'o-secret' }).problems).toEqual(['your organisation sign-in is off: OIDC_ISSUER is not set']);
  });

  it('takes a plain http issuer only on this machine\'s own addresses', () => {
    expect(signInProvidersFrom({ OIDC_ISSUER: 'http://login.example.com', OIDC_CLIENT_ID: 'o', OIDC_CLIENT_SECRET: 's' }).problems).toEqual(['your organisation sign-in is off: your organisation\'s issuer http://login.example.com is not https, and only this machine\'s own addresses may be plain http']);
    expect(signInProvidersFrom({ OIDC_ISSUER: 'http://127.0.0.1:4100', OIDC_CLIENT_ID: 'o', OIDC_CLIENT_SECRET: 's' }).providers).toHaveLength(1);
    expect(addressProblem('not an address', 'the issuer')).toBe('the issuer not an address is not an address');
  });

  it('shows the browser each provider\'s id and label, never its credentials', () => {
    const { providers } = signInProvidersFrom({ GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 'g-secret', GITHUB_CLIENT_ID: 'h-id', GITHUB_CLIENT_SECRET: 'h-secret' });
    expect(offeredProviders(providers)).toEqual([{ id: 'google', label: 'Google' }, { id: 'github', label: 'GitHub' }]);
  });

  it('names each provider\'s callback under the public address, the address registered with the provider', () => {
    expect(providerCallbackUrl('https://app.nowrinkles.dev/', 'google')).toBe('https://app.nowrinkles.dev/api/auth/provider/google/callback');
    expect(new Set(SIGN_IN_PROVIDERS.map((provider) => provider.id)).size).toBe(SIGN_IN_PROVIDERS.length);
  });

  it('reads who signed in from the ID token\'s subject, email and email_verified', () => {
    expect(identityFromIdToken({ sub: '1234', email: ' Ann@Example.com', email_verified: true })).toEqual({ subject: '1234', email: 'ann@example.com', verified: true });
    expect(identityFromIdToken({ sub: '1234', email: 'ann@example.com', email_verified: 'true' }).verified).toBe(true);
    expect(identityFromIdToken({ sub: '1234', email: 'ann@example.com' }).verified).toBe(false);
    expect(() => identityFromIdToken({ sub: '1234' })).toThrow('it gave no email address');
    expect(() => identityFromIdToken({ email: 'ann@example.com' })).toThrow('it named nobody');
  });
});
