import { describe, it, expect } from 'vitest';
import { githubPrimaryEmail, providerMatch, type ProviderPerson } from './provider-sign-in.js';
import type { UserMetadata } from '../../platform/index.js';

const ann = (over: Partial<UserMetadata> = {}): UserMetadata => ({ id: 'ann', email: 'ann@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: '', ...over }) as UserMetadata;
const github = (over: Partial<ProviderPerson> = {}): ProviderPerson => ({ provider: 'GitHub', field: 'githubId', id: '42', email: 'ann@example.com', verified: true, ...over });

describe('signing in with Google or GitHub', () => {
  it('signs in whoever that provider account is already linked to, whatever its email now says', () => {
    expect(providerMatch(github({ email: 'changed@example.com', verified: false }), ann({ githubId: '42' }), undefined)).toEqual({ kind: 'existing', user: ann({ githubId: '42' }), link: false });
  });

  it('links an account by its email only when the provider says the email is verified', () => {
    expect(providerMatch(github(), undefined, ann())).toEqual({ kind: 'existing', user: ann(), link: true });
    expect(providerMatch(github({ verified: false }), undefined, ann())).toEqual({ kind: 'refused', why: 'GitHub does not say ann@example.com is verified; verify it there, or sign in with your password' });
  });

  it('never joins a provider to an account whose address was never confirmed, though one already joined still signs in', () => {
    expect(providerMatch(github(), undefined, ann({ emailVerified: false }))).toEqual({ kind: 'refused', why: 'An account here has ann@example.com, but that address was never confirmed, so GitHub cannot join it; sign in with its password' });
    expect(providerMatch(github(), undefined, ann({ emailVerified: false, githubId: '42' }))).toEqual({ kind: 'existing', user: ann({ emailVerified: false, githubId: '42' }), link: false });
  });

  it('refuses an email whose account is linked to another account at that provider', () => {
    expect(providerMatch(github(), undefined, ann({ githubId: '7' }))).toEqual({ kind: 'refused', why: 'ann@example.com is linked to another GitHub account' });
  });

  it('makes a new account only for a verified email', () => {
    expect(providerMatch(github(), undefined, undefined)).toEqual({ kind: 'new' });
    expect(providerMatch(github({ verified: false }), undefined, undefined).kind).toBe('refused');
  });

  it('takes GitHub\'s primary address, saying whether it is verified, and never another', () => {
    expect(githubPrimaryEmail([{ email: 'Other@Example.com', verified: true }, { email: ' Ann@Example.com', primary: true, verified: true }])).toEqual({ email: 'ann@example.com', verified: true });
    expect(githubPrimaryEmail([{ email: 'ann@example.com', primary: true, verified: false }])).toEqual({ email: 'ann@example.com', verified: false });
    expect(githubPrimaryEmail([{ email: 'other@example.com', verified: true }])).toBeUndefined();
  });
});
