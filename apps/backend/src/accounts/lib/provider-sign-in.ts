import type { UserMetadata } from '../../platform/index.js';

export type ProviderField = 'githubId' | 'googleId';

export interface ProviderPerson {
  provider: 'GitHub' | 'Google';
  field: ProviderField;
  id: string;
  email: string;
  verified: boolean;
}

export type ProviderMatch =
  | { kind: 'refused'; why: string }
  | { kind: 'existing'; user: UserMetadata; link: boolean }
  | { kind: 'new' };

export function providerMatch(person: ProviderPerson, byId: UserMetadata | undefined, byEmail: UserMetadata | undefined): ProviderMatch {
  if (byId) return { kind: 'existing', user: byId, link: false };
  if (!person.verified) return { kind: 'refused', why: `${person.provider} does not say ${person.email} is verified; verify it there, or sign in with your password` };
  if (!byEmail) return { kind: 'new' };
  const linked = byEmail[person.field];
  if (linked && linked !== person.id) return { kind: 'refused', why: `${person.email} is linked to another ${person.provider} account` };
  return { kind: 'existing', user: byEmail, link: !linked };
}

export interface GithubEmail { email: string; primary?: boolean; verified?: boolean }

export function githubPrimaryEmail(emails: readonly GithubEmail[]): { email: string; verified: boolean } | undefined {
  const primary = emails.find((entry) => entry.primary);
  return primary ? { email: primary.email.trim().toLowerCase(), verified: primary.verified === true } : undefined;
}
