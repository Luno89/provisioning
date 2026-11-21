import * as client from 'openid-client';
import { importJWK } from 'jose';
import { identityKeysFrom } from '../../apps/backend/src/instances/lib/identity-token.js';
import { privateJwkOf, SERVICE_SCOPE, SIGNING_ALG } from '../../apps/backend/src/instances/lib/oidc.js';

export async function instanceServiceToken(reach: { rootForHost: string; rootIssuedAs: string }, instanceId: string, clientKeyPem: string): Promise<string> {
  const keys = identityKeysFrom(clientKeyPem);
  const discovered = await (await fetch(`${reach.rootForHost}/oidc/.well-known/openid-configuration`)).json() as Record<string, unknown>;
  const metadata = Object.fromEntries(Object.entries(discovered).map(([name, value]) => [name, typeof value === 'string' && name !== 'issuer' ? value.replace(reach.rootIssuedAs, reach.rootForHost) : value])) as unknown as client.ServerMetadata;
  const key = await importJWK(privateJwkOf(keys), SIGNING_ALG) as Extract<Parameters<typeof client.PrivateKeyJwt>[0], { type: string }>;
  const config = new client.Configuration(metadata, instanceId, { token_endpoint_auth_signing_alg: SIGNING_ALG }, client.PrivateKeyJwt({ key, kid: keys.kid }));
  client.allowInsecureRequests(config);
  return (await client.clientCredentialsGrant(config, { scope: SERVICE_SCOPE })).access_token;
}
