export type RevocationReason =
  | 'signed-out-everywhere'
  | 'two-factor-changed'
  | 'account-removed';

export const REVOCATION_REASONS: readonly RevocationReason[] = ['signed-out-everywhere', 'two-factor-changed', 'account-removed'];

export interface AccessRevoked {
  subject: string;
  at: string;
  why: RevocationReason;
}

export type AccessRevokedListener = (event: AccessRevoked) => Promise<void> | void;

export const revocationShaped = (value: unknown): value is AccessRevoked => {
  const event = value as Partial<AccessRevoked> | undefined;
  return typeof event?.subject === 'string' && event.subject.length > 0
    && typeof event.at === 'string' && !Number.isNaN(Date.parse(event.at))
    && REVOCATION_REASONS.includes(event.why as RevocationReason);
};

export class AccessRevocations {
  private readonly listeners: AccessRevokedListener[] = [];

  on(listener: AccessRevokedListener): void {
    this.listeners.push(listener);
  }

  async revoked(event: AccessRevoked): Promise<void> {
    for (const listener of this.listeners) await listener(event);
  }
}
