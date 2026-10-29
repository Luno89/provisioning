export type RevokedBecause = 'signed-out-everywhere' | 'password-or-2fa' | 'removed-from-shared-project' | 'account-removed' | 'locked';

export const REVOKED_BECAUSE: readonly RevokedBecause[] = ['signed-out-everywhere', 'password-or-2fa', 'removed-from-shared-project', 'account-removed', 'locked'];

export const REVOKED_SAID: Readonly<Record<RevokedBecause, string>> = {
  'signed-out-everywhere': 'they signed out everywhere',
  'password-or-2fa': 'their password or two-factor sign-in changed',
  'removed-from-shared-project': 'they were removed from the shared project',
  'account-removed': 'their account is being removed',
  locked: 'their account was locked',
};

export interface AccessRevoked {
  personId: string;
  because: RevokedBecause;
  at: string;
  sharedProjectId?: string | undefined;
}

export const revocationShaped = (value: unknown): value is AccessRevoked => {
  const event = value as Partial<AccessRevoked> | undefined;
  return typeof event?.personId === 'string' && event.personId.length > 0
    && typeof event.at === 'string' && !Number.isNaN(Date.parse(event.at))
    && REVOKED_BECAUSE.includes(event.because as RevokedBecause)
    && (event.sharedProjectId === undefined || (typeof event.sharedProjectId === 'string' && event.sharedProjectId.length > 0));
};

export const endsSessions = (revoked: AccessRevoked): boolean => revoked.sharedProjectId === undefined;
