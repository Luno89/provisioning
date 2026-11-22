import { generateIdentityKey, identityKeysFrom } from '../lib/identity-token.js';
import { publicJwkOf, type PublicJwk } from '../lib/oidc.js';

export const rootWebFor = (publicUrl: string): { publicUrl: string; key: PublicJwk } =>
  ({ publicUrl, key: publicJwkOf(identityKeysFrom(generateIdentityKey())) });
