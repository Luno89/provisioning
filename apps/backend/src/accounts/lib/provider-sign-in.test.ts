import { describe, it, expect } from 'vitest';
import { githubPrimaryEmail, linkedTo, linksFromLegacyIds, providerMatch, readiedForProviderLink, type ProviderPerson } from './provider-sign-in.js';
import type { UserMetadata } from '../../platform/index.js';

const GITHUB = 'https://github.com';
const ann = (over: Partial<UserMetadata> = {}): UserMetadata => ({ id: 'ann', email: 'ann@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: '', ...over }) as UserMetadata;
const github = (over: Partial<ProviderPerson> = {}): ProviderPerson => ({ provider: 'GitHub', issuer: GITHUB, subject: '42', email: 'ann@example.com', verified: true, ...over });
const at = (subject: string, issuer = GITHUB) => ({ signInLinks: [{ issuer, subject }] });

describe('signing in with a provider', () => {
  it('signs in whoever that provider account is already linked to, whatever its email now says', () => {
    expect(providerMatch(github({ email: 'changed@example.com', verified: false }), ann(at('42')), undefined)).toEqual({ kind: 'existing', user: ann(at('42')), link: false });
  });

  it('links an account by its email only when the provider says the email is verified', () => {
    expect(providerMatch(github(), undefined, ann())).toEqual({ kind: 'existing', user: ann(), link: true });
    expect(providerMatch(github({ verified: false }), undefined, ann())).toEqual({ kind: 'refused', why: 'GitHub does not say ann@example.com is verified; verify it there, or sign in with your password' });
  });

  it('never joins a provider to an account whose address was never confirmed, though one already joined still signs in', () => {
    expect(providerMatch(github(), undefined, ann({ emailVerified: false }))).toEqual({ kind: 'refused', why: 'An account here has ann@example.com, but that address was never confirmed, so GitHub cannot join it; sign in with its password' });
    expect(providerMatch(github(), undefined, ann({ emailVerified: false, ...at('42') }))).toEqual({ kind: 'existing', user: ann({ emailVerified: false, ...at('42') }), link: false });
  });

  it('refuses an email whose account is linked to another account at that provider, and not one linked only elsewhere', () => {
    expect(providerMatch(github(), undefined, ann(at('7')))).toEqual({ kind: 'refused', why: 'ann@example.com is linked to another GitHub account' });
    expect(providerMatch(github(), undefined, ann(at('7', 'https://accounts.google.com')))).toEqual({ kind: 'existing', user: ann(at('7', 'https://accounts.google.com')), link: true });
  });

  it('makes a new account only for a verified email', () => {
    expect(providerMatch(github(), undefined, undefined)).toEqual({ kind: 'new' });
    expect(providerMatch(github({ verified: false }), undefined, undefined).kind).toBe('refused');
  });

  it('keeps one link per issuer when linking', () => {
    expect(linkedTo(ann(at('7', 'https://accounts.google.com')), github()).signInLinks).toEqual([{ issuer: 'https://accounts.google.com', subject: '7' }, { issuer: GITHUB, subject: '42' }]);
  });

  it('takes GitHub\'s primary address, saying whether it is verified, and never another', () => {
    expect(githubPrimaryEmail([{ email: 'Other@Example.com', verified: true }, { email: ' Ann@Example.com', primary: true, verified: true }])).toEqual({ email: 'ann@example.com', verified: true });
    expect(githubPrimaryEmail([{ email: 'ann@example.com', primary: true, verified: false }])).toEqual({ email: 'ann@example.com', verified: false });
    expect(githubPrimaryEmail([{ email: 'other@example.com', verified: true }])).toBeUndefined();
  });

  it('moves the ids stored before links onto links under their issuer, once', () => {
    expect(linksFromLegacyIds({ googleId: 'g-1', githubId: '42' })).toEqual([{ issuer: 'https://accounts.google.com', subject: 'g-1' }, { issuer: GITHUB, subject: '42' }]);
    expect(linksFromLegacyIds({ githubId: '42', ...at('9') })).toEqual([{ issuer: GITHUB, subject: '9' }]);
    expect(linksFromLegacyIds({})).toEqual([]);
  });
});

describe('readying an account for its first real provider sign-in', () => {
  const owner = ann({ id: 'owner', email: 'mock-google-user@example.com', emailVerified: false, signInLinks: [{ issuer: 'https://accounts.google.com', subject: 'google-mock-id' }], googleId: 'google-mock-id' } as Partial<UserMetadata>);

  it('takes the given address as confirmed and forgets every link and stored provider id, so the next sign-in links by that address', () => {
    const readied = readiedForProviderLink(owner, 'owner@gmail.com', undefined);
    expect(readied).toEqual({ ok: true, user: { id: 'owner', email: 'owner@gmail.com', emailVerified: true, twoFactorEnabled: false, createdAt: '' } });
    if (!readied.ok) return;
    expect(providerMatch(github({ email: 'owner@gmail.com' }), undefined, readied.user)).toEqual({ kind: 'existing', user: readied.user, link: true });
  });

  it('refuses an address another account already has', () => {
    expect(readiedForProviderLink(owner, 'ann@example.com', { id: 'ann' })).toEqual({ ok: false, why: 'ann@example.com is already the address of another account (ann)' });
    expect(readiedForProviderLink(owner, 'mock-google-user@example.com', { id: 'owner' }).ok).toBe(true);
  });
});
