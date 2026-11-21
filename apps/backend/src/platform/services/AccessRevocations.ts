import type { AccessRevoked } from '../lib/revocations.js';

export type RevocationListener = (revoked: AccessRevoked) => Promise<unknown>;

export class AccessRevocations {
  private readonly listeners: RevocationListener[] = [];

  listen(listener: RevocationListener): void {
    this.listeners.push(listener);
  }

  async revoked(revoked: AccessRevoked): Promise<string[]> {
    const failed = (await Promise.allSettled(this.listeners.map((listener) => listener(revoked))))
      .flatMap((settled) => (settled.status === 'rejected' ? [(settled.reason as Error).message] : []));
    for (const why of failed) console.warn(`[revocations] ${revoked.because} for ${revoked.personId} did not reach every listener: ${why}`);
    return failed;
  }
}
