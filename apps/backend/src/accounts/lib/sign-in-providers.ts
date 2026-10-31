export type SignInProviderKind = 'oidc' | 'github';

export interface SignInEnvNames {
  clientId: string;
  clientSecret: string;
  issuer?: string;
  label?: string;
}

export interface GithubEndpoints {
  authorization: string;
  token: string;
  api: string;
}

export interface SignInRegistration {
  url?: string;
  how: string;
}

export interface SignInProviderDescription {
  id: string;
  label: string;
  kind: SignInProviderKind;
  issuer?: string;
  github?: GithubEndpoints;
  scopes: readonly string[];
  env: SignInEnvNames;
  register: SignInRegistration;
}

export type SignInFieldKey = keyof SignInEnvNames;

export interface SignInField {
  key: SignInFieldKey;
  label: string;
  env: string;
  secret: boolean;
  optional: boolean;
  placeholder: string;
}

export interface SignInProvider {
  id: string;
  label: string;
  kind: SignInProviderKind;
  issuer: string;
  scopes: readonly string[];
  clientId: string;
  clientSecret: string;
  github?: GithubEndpoints | undefined;
}

export interface OfferedProvider {
  id: string;
  label: string;
}

export interface SignInChecks {
  state: string;
  verifier: string;
  nonce: string;
}

export interface ProviderIdentity {
  subject: string;
  email: string;
  verified: boolean;
}

export interface SignInClient {
  authorizationUrl(redirectUri: string, checks: SignInChecks): Promise<URL>;
  identify(callback: URL, checks: SignInChecks): Promise<ProviderIdentity>;
}

export class SignInRefusal extends Error {}

export const GITHUB_ISSUER = 'https://github.com';

export const GOOGLE_SIGN_IN: SignInProviderDescription = {
  id: 'google',
  label: 'Google',
  kind: 'oidc',
  issuer: 'https://accounts.google.com',
  scopes: ['openid', 'email', 'profile'],
  env: { clientId: 'GOOGLE_CLIENT_ID', clientSecret: 'GOOGLE_CLIENT_SECRET' },
  register: {
    url: 'https://console.cloud.google.com/apis/credentials',
    how: 'Create credentials → OAuth client ID, of type Web application, with the redirect URI below as an authorised redirect URI. Google shows the client ID and secret once it is made.',
  },
};

export const GITHUB_SIGN_IN: SignInProviderDescription = {
  id: 'github',
  label: 'GitHub',
  kind: 'github',
  issuer: GITHUB_ISSUER,
  github: { authorization: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', api: 'https://api.github.com' },
  scopes: ['user:email'],
  env: { clientId: 'GITHUB_CLIENT_ID', clientSecret: 'GITHUB_CLIENT_SECRET' },
  register: {
    url: 'https://github.com/settings/applications/new',
    how: 'Register a new OAuth app with the redirect URI below as its authorization callback URL, then generate a client secret on its page.',
  },
};

export const OWN_OIDC_SIGN_IN: SignInProviderDescription = {
  id: 'oidc',
  label: 'your organisation',
  kind: 'oidc',
  scopes: ['openid', 'email', 'profile'],
  env: { clientId: 'OIDC_CLIENT_ID', clientSecret: 'OIDC_CLIENT_SECRET', issuer: 'OIDC_ISSUER', label: 'OIDC_LABEL' },
  register: {
    how: 'At your organisation\'s OpenID provider (Keycloak, Authentik, Okta, Microsoft Entra and the like), register a confidential web client with the redirect URI below and the scopes openid, email and profile. Its issuer is the address its /.well-known/openid-configuration is served under.',
  },
};

export const SIGN_IN_PROVIDERS: readonly SignInProviderDescription[] = [GOOGLE_SIGN_IN, GITHUB_SIGN_IN, OWN_OIDC_SIGN_IN];

export function signInFieldsOf(description: SignInProviderDescription): SignInField[] {
  const fields: SignInField[] = [];
  if (description.env.issuer && !description.issuer) {
    fields.push({ key: 'issuer', label: 'Issuer', env: description.env.issuer, secret: false, optional: false, placeholder: 'https://login.example.com/realms/staff' });
  }
  fields.push({ key: 'clientId', label: 'Client ID', env: description.env.clientId, secret: false, optional: false, placeholder: '' });
  fields.push({ key: 'clientSecret', label: 'Client secret', env: description.env.clientSecret, secret: true, optional: false, placeholder: '' });
  if (description.env.label) {
    fields.push({ key: 'label', label: 'Button label', env: description.env.label, secret: false, optional: true, placeholder: description.label });
  }
  return fields;
}

export const signInEnvNames = (described: readonly SignInProviderDescription[] = SIGN_IN_PROVIDERS): string[] =>
  described.flatMap((description) => signInFieldsOf(description).map((field) => field.env));

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function plainHttpAllowed(address: string): boolean {
  const url = new URL(address);
  return url.protocol === 'http:' && LOOPBACK.has(url.hostname);
}

export function addressProblem(address: string, what: string): string | undefined {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return `${what} ${address} is not an address`;
  }
  if (url.protocol === 'https:' || plainHttpAllowed(address)) return undefined;
  return `${what} ${address} is not https, and only this machine's own addresses may be plain http`;
}

export interface ConfiguredSignIn {
  providers: SignInProvider[];
  problems: string[];
}

export function signInProvidersFrom(env: Readonly<Record<string, string | undefined>>, described: readonly SignInProviderDescription[] = SIGN_IN_PROVIDERS): ConfiguredSignIn {
  const providers: SignInProvider[] = [];
  const problems: string[] = [];
  for (const description of described) {
    const read = (name: string | undefined) => (name ? env[name]?.trim() || undefined : undefined);
    const clientId = read(description.env.clientId);
    const clientSecret = read(description.env.clientSecret);
    const issuer = description.issuer ?? read(description.env.issuer);
    const label = read(description.env.label) ?? description.label;
    const named = [description.env.clientId, description.env.clientSecret, ...(description.issuer ? [] : [description.env.issuer!])];
    const given = [clientId, clientSecret, ...(description.issuer ? [] : [issuer])];
    if (given.every((value) => value === undefined)) continue;
    const missing = named.filter((_, at) => given[at] === undefined);
    if (missing.length) {
      problems.push(`${label} sign-in is off: ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set`);
      continue;
    }
    const wrong = addressProblem(issuer!, `${label}'s issuer`);
    if (wrong) {
      problems.push(`${label} sign-in is off: ${wrong}`);
      continue;
    }
    providers.push({
      id: description.id,
      label,
      kind: description.kind,
      issuer: issuer!.replace(/\/+$/, ''),
      scopes: description.scopes,
      clientId: clientId!,
      clientSecret: clientSecret!,
      ...(description.github ? { github: description.github } : {}),
    });
  }
  return { providers, problems };
}

export const offeredProviders = (providers: readonly SignInProvider[]): OfferedProvider[] => providers.map(({ id, label }) => ({ id, label }));

export const providerStartPath = (id: string): string => `/api/auth/provider/${encodeURIComponent(id)}`;

export const providerCallbackUrl = (publicUrl: string, id: string): string => `${publicUrl.replace(/\/+$/, '')}${providerStartPath(id)}/callback`;

export function identityFromIdToken(claims: Readonly<Record<string, unknown>>): ProviderIdentity {
  const subject = typeof claims.sub === 'string' ? claims.sub : '';
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!subject) throw new SignInRefusal('it named nobody');
  if (!email) throw new SignInRefusal('it gave no email address');
  return { subject, email, verified: claims.email_verified === true || claims.email_verified === 'true' };
}
