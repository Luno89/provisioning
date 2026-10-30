import * as client from 'openid-client';
import { plainHttpAllowed, SignInRefusal, type ProviderIdentity, type SignInChecks, type SignInClient, type SignInProvider } from '../../lib/sign-in-providers.js';
import { githubPrimaryEmail, type GithubEmail } from '../../lib/provider-sign-in.js';

export function githubSignIn(provider: SignInProvider): SignInClient {
  const endpoints = provider.github;
  if (!endpoints) throw new Error(`${provider.label} is GitHub's kind of sign-in but names none of GitHub's addresses`);
  const config = new client.Configuration(
    { issuer: provider.issuer, authorization_endpoint: endpoints.authorization, token_endpoint: endpoints.token },
    provider.clientId,
    provider.clientSecret,
  );
  if (plainHttpAllowed(endpoints.token)) client.allowInsecureRequests(config);

  const read = async <T>(path: string, token: string): Promise<T> => {
    const answer = await fetch(`${endpoints.api}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'koala-sign-in' },
    });
    if (!answer.ok) throw new SignInRefusal(`GitHub answered ${answer.status} when asked for ${path}`);
    return answer.json() as Promise<T>;
  };

  return {
    async authorizationUrl(redirectUri: string, checks: SignInChecks): Promise<URL> {
      return client.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope: provider.scopes.join(' '),
        code_challenge: await client.calculatePKCECodeChallenge(checks.verifier),
        code_challenge_method: 'S256',
        state: checks.state,
      });
    },
    async identify(callback: URL, checks: SignInChecks): Promise<ProviderIdentity> {
      const tokens = await client.authorizationCodeGrant(config, callback, { pkceCodeVerifier: checks.verifier, expectedState: checks.state });
      const person = await read<{ id?: unknown }>('/user', tokens.access_token);
      if (typeof person.id !== 'number' && typeof person.id !== 'string') throw new SignInRefusal('GitHub named nobody');
      const primary = githubPrimaryEmail(await read<GithubEmail[]>('/user/emails', tokens.access_token));
      if (!primary) throw new SignInRefusal('GitHub gave no primary email address; add one there, or sign in with your password');
      return { subject: String(person.id), email: primary.email, verified: primary.verified };
    },
  };
}
