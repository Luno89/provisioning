import * as client from 'openid-client';
import { identityFromIdToken, plainHttpAllowed, SignInRefusal, type SignInChecks, type SignInClient, type SignInProvider } from '../../lib/sign-in-providers.js';

export const reachedOverPlainHttp = (provider: Pick<SignInProvider, 'issuer'>): ((config: client.Configuration) => void)[] =>
  plainHttpAllowed(provider.issuer) ? [client.allowInsecureRequests] : [];

export function oidcSignIn(provider: SignInProvider): SignInClient {
  let configured: Promise<client.Configuration> | undefined;
  const config = (): Promise<client.Configuration> => {
    configured ??= client.discovery(new URL(provider.issuer), provider.clientId, provider.clientSecret, undefined, {
      execute: [...reachedOverPlainHttp(provider), client.enableNonRepudiationChecks],
    });
    configured.catch(() => { configured = undefined; });
    return configured;
  };

  return {
    async authorizationUrl(redirectUri: string, checks: SignInChecks): Promise<URL> {
      return client.buildAuthorizationUrl(await config(), {
        redirect_uri: redirectUri,
        scope: provider.scopes.join(' '),
        code_challenge: await client.calculatePKCECodeChallenge(checks.verifier),
        code_challenge_method: 'S256',
        state: checks.state,
        nonce: checks.nonce,
      });
    },
    async identify(callback: URL, checks: SignInChecks) {
      const tokens = await client.authorizationCodeGrant(await config(), callback, {
        pkceCodeVerifier: checks.verifier,
        expectedState: checks.state,
        expectedNonce: checks.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims) throw new SignInRefusal('it sent no identity');
      return identityFromIdToken(claims);
    },
  };
}
