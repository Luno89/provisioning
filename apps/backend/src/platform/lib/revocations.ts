export type RevokedBecause = 'signed-out-everywhere' | 'password-or-2fa' | 'account-removed';

export const REVOKED_BECAUSE: readonly RevokedBecause[] = ['signed-out-everywhere', 'password-or-2fa', 'account-removed'];

export const REVOKED_SAID: Readonly<Record<RevokedBecause, string>> = {
  'signed-out-everywhere': 'they signed out everywhere',
  'password-or-2fa': 'their password or two-factor sign-in changed',
  'account-removed': 'their account is being removed',
};

export interface KeptSession {
  session: string;
  rootSid: string;
  browser?: string | undefined;
}

export interface AccessRevoked {
  personId: string;
  because: RevokedBecause;
  at: string;
  kept?: KeptSession | undefined;
}

export const revocationShaped = (value: unknown): value is AccessRevoked => {
  const event = value as Partial<AccessRevoked> | undefined;
  return typeof event?.personId === 'string' && event.personId.length > 0
    && typeof event.at === 'string' && !Number.isNaN(Date.parse(event.at))
    && REVOKED_BECAUSE.includes(event.because as RevokedBecause);
};
