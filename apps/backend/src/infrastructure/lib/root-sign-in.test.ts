import { describe, expect, it } from 'vitest';
import { SIGN_IN_PROVIDERS, signInEnvNames, type SignInProviderDescription } from '../../accounts/lib/sign-in-providers.js';
import { missingFromEnvFile, rootSignInEnv, rootSignInProviders, signInSecretsOf } from './root-sign-in.js';

const GOOGLE = { id: 'google', values: { clientId: 'google-id.apps.googleusercontent.com', clientSecret: 'google-fake-google-secret' } };
const OWN = { id: 'oidc', values: { issuer: 'https://login.example.com/realms/staff', clientId: 'koala', clientSecret: 'own-secret-value', label: 'Example staff' } };

describe('the sign-in providers Host Koala offers for root', () => {
  it('lists every provider the registry describes, with its fields, where it is made and root\'s redirect URI for it', () => {
    const offered = rootSignInProviders('nowrinkles.dev');
    expect(offered.map((provider) => provider.id)).toEqual(SIGN_IN_PROVIDERS.map((provider) => provider.id));
    const google = offered.find((provider) => provider.id === 'google')!;
    expect(google.redirectUri).toBe('https://app.nowrinkles.dev/api/auth/provider/google/callback');
    expect(google.register.url).toBe('https://console.cloud.google.com/apis/credentials');
    expect(google.fields.map((field) => [field.key, field.env, field.secret])).toEqual([['clientId', 'GOOGLE_CLIENT_ID', false], ['clientSecret', 'GOOGLE_CLIENT_SECRET', true]]);
    const own = offered.find((provider) => provider.id === 'oidc')!;
    expect(own.fields.map((field) => field.env)).toEqual(['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_LABEL']);
    expect(own.fields.find((field) => field.key === 'label')?.optional).toBe(true);
    expect(rootSignInProviders('not a domain').every((provider) => provider.redirectUri === undefined)).toBe(true);
    expect(rootSignInProviders(undefined)[0]!.redirectUri).toBeUndefined();
  });

  it('offers a provider added to the registry later without anything else changing', () => {
    const later: SignInProviderDescription = {
      id: 'gitlab', label: 'GitLab', kind: 'oidc', issuer: 'https://gitlab.com', scopes: ['openid', 'email'],
      env: { clientId: 'GITLAB_CLIENT_ID', clientSecret: 'GITLAB_CLIENT_SECRET' }, register: { url: 'https://gitlab.com/-/user_settings/applications', how: 'Add an application.' },
    };
    const described = [...SIGN_IN_PROVIDERS, later];
    expect(rootSignInProviders('nowrinkles.dev', described).at(-1)).toMatchObject({ id: 'gitlab', redirectUri: 'https://app.nowrinkles.dev/api/auth/provider/gitlab/callback' });
    expect(rootSignInEnv([{ id: 'gitlab', values: { clientId: 'gl', clientSecret: 'gl-secret' } }], described)).toEqual({ env: { GITLAB_CLIENT_ID: 'gl', GITLAB_CLIENT_SECRET: 'gl-secret' }, chosen: [{ id: 'gitlab', label: 'GitLab' }] });
    expect(signInEnvNames(described)).toContain('GITLAB_CLIENT_SECRET');
  });
});

describe('the sign-in keys an order carries to root', () => {
  it('is optional: none at all is passwords only', () => {
    expect(rootSignInEnv(undefined)).toEqual({ env: {}, chosen: [] });
    expect(rootSignInEnv([])).toEqual({ env: {}, chosen: [] });
    expect(rootSignInEnv([{ id: 'github', values: { clientId: '  ', clientSecret: '' } }])).toEqual({ env: {}, chosen: [] });
  });

  it('turns each provider given into the env root reads, trimmed', () => {
    expect(rootSignInEnv([GOOGLE, { id: 'oidc', values: { ...OWN.values, clientId: ' koala ' } }])).toEqual({
      env: {
        GOOGLE_CLIENT_ID: GOOGLE.values.clientId, GOOGLE_CLIENT_SECRET: GOOGLE.values.clientSecret,
        OIDC_ISSUER: OWN.values.issuer, OIDC_CLIENT_ID: 'koala', OIDC_CLIENT_SECRET: OWN.values.clientSecret, OIDC_LABEL: 'Example staff',
      },
      chosen: [{ id: 'google', label: 'Google' }, { id: 'oidc', label: 'Example staff' }],
    });
  });

  it('refuses a half-given provider, a plain-http issuer, an unknown or repeated one, and a value .env cannot hold', () => {
    expect(rootSignInEnv([{ id: 'google', values: { clientId: 'only-the-id' } }])).toEqual({ problem: expect.stringMatching(/Google sign-in is off: GOOGLE_CLIENT_SECRET is not set/) });
    expect(rootSignInEnv([{ id: 'oidc', values: { ...OWN.values, issuer: 'http://login.example.com' } }])).toEqual({ problem: expect.stringMatching(/is not https/) });
    expect(rootSignInEnv([{ id: 'myspace', values: {} }])).toEqual({ problem: expect.stringMatching(/no sign-in provider "myspace"/) });
    expect(rootSignInEnv([GOOGLE, GOOGLE])).toEqual({ problem: 'Google is named twice.' });
    expect(rootSignInEnv([{ id: 'google', values: { ...GOOGLE.values, clientSecret: "it's" } }])).toEqual({ problem: expect.stringMatching(/single quote/) });
    expect(rootSignInEnv([{ id: 'google', values: { ...GOOGLE.values, clientSecret: 'a\nb' } }])).toEqual({ problem: expect.stringMatching(/line break/) });
    expect(rootSignInEnv({ google: GOOGLE.values })).toEqual({ problem: expect.stringMatching(/as a list/) });
    expect(rootSignInEnv([{ id: 'google', values: { clientId: 7, clientSecret: 'x' } }])).toEqual({ problem: expect.stringMatching(/not text/) });
  });

  it('names the values the order\'s log hides, and what root\'s .env lacks', () => {
    const { env } = rootSignInEnv([GOOGLE, OWN]) as { env: Record<string, string> };
    expect(signInSecretsOf(env).sort()).toEqual([GOOGLE.values.clientId, GOOGLE.values.clientSecret, 'koala', OWN.values.clientSecret].sort());
    expect(missingFromEnvFile('ROLE=root\nGOOGLE_CLIENT_ID=\nGOOGLE_CLIENT_SECRET=x\n', { GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', OIDC_ISSUER: 'c' })).toEqual(['OIDC_ISSUER']);
  });
});
