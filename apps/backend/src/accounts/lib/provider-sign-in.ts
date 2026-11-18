import type { SignInLink, UserMetadata } from '../../platform/index.js';

export interface ProviderPerson {
  provider: string;
  issuer: string;
  subject: string;
  email: string;
  verified: boolean;
}

export type ProviderMatch =
  | { kind: 'refused'; why: string }
  | { kind: 'existing'; user: UserMetadata; link: boolean }
  | { kind: 'new' };

export const linkAt = (user: Pick<UserMetadata, 'signInLinks'>, issuer: string): SignInLink | undefined =>
  (user.signInLinks ?? []).find((link) => link.issuer === issuer);

export const linkedTo = (user: UserMetadata, person: Pick<ProviderPerson, 'issuer' | 'subject'>): UserMetadata => ({
  ...user,
  signInLinks: [...(user.signInLinks ?? []).filter((link) => link.issuer !== person.issuer), { issuer: person.issuer, subject: person.subject }],
});

export function providerMatch(person: ProviderPerson, bySubject: UserMetadata | undefined, byEmail: UserMetadata | undefined): ProviderMatch {
  if (bySubject) return { kind: 'existing', user: bySubject, link: false };
  if (!person.verified) return { kind: 'refused', why: `${person.provider} does not say ${person.email} is verified; verify it there, or sign in with your password` };
  if (!byEmail) return { kind: 'new' };
  const linked = linkAt(byEmail, person.issuer);
  if (linked && linked.subject !== person.subject) return { kind: 'refused', why: `${person.email} is linked to another ${person.provider} account` };
  if (!linked && !byEmail.emailVerified) return { kind: 'refused', why: `An account here has ${person.email}, but that address was never confirmed, so ${person.provider} cannot join it; sign in with its password` };
  return { kind: 'existing', user: byEmail, link: !linked };
}

export interface GithubEmail { email: string; primary?: boolean; verified?: boolean }

export function githubPrimaryEmail(emails: readonly GithubEmail[]): { email: string; verified: boolean } | undefined {
  const primary = emails.find((entry) => entry.primary);
  return primary ? { email: primary.email.trim().toLowerCase(), verified: primary.verified === true } : undefined;
}

export type ReadiedForLink =
  | { ok: true; user: UserMetadata }
  | { ok: false; why: string };

export function readiedForProviderLink(user: UserMetadata, email: string, emailOwner: Pick<UserMetadata, 'id'> | undefined): ReadiedForLink {
  if (emailOwner && emailOwner.id !== user.id) return { ok: false, why: `${email} is already the address of another account (${emailOwner.id})` };
  const { signInLinks: _signInLinks, ...rest } = user;
  return { ok: true, user: { ...rest, email, emailVerified: true } };
}
