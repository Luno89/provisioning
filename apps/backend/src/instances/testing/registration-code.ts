import type { Database } from '../../platform/index.js';
import type { IdentityKeyPair } from '../lib/identity-token.js';
import { InstanceReach } from '../services/InstanceReach.js';
import { RootProvider } from '../services/RootProvider.js';

export const registrationCodeAt = (root: { db: Pick<Database, 'instances' | 'accounts'>; url: string; signing: IdentityKeyPair }, instance: { id: string; ownerId: string }): Promise<string> =>
  new RootProvider({ issuer: `${root.url}/oidc`, signing: root.signing, cookieKey: 'a-provider-that-only-makes-a-registration-code', proxied: false, reach: new InstanceReach({ open: true }) }, root.db).registrationCode(instance);
