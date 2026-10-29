import type { AccessRevoked } from '../lib/revocations.js';

export type RevocationListener = (revoked: AccessRevoked) => Promise<unknown>;

export class AccessRevocations {
  private readonly listeners: RevocationListener[] = [];

  listen(listener: RevocationListener): void {
    this.listeners.push(listener);
  }

  async revoked(revoked: AccessRevoked): Promise<void> {
    await Promise.all(this.listeners.map((listener) => listener(revoked).catch((err: Error) =>
      console.warn(`[revocations] ${revoked.because} for ${revoked.personId} did not reach every listener: ${err.message}`))));
  }
}
