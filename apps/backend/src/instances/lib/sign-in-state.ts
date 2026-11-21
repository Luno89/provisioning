import type { RevokedBecause } from '../../platform/index.js';

export interface LogoutDelivery {
  id: string;
  clientId: string;
  url: string;
  subject: string;
  revokedAt: string;
  why: RevokedBecause;
  attempts?: number | undefined;
  lastError?: string | undefined;
  lastTriedAt?: string | undefined;
}
