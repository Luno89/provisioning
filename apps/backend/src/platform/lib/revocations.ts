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
  sharedProjectId?: string | undefined;
}
