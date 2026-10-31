import {
  providerCallbackUrl, SIGN_IN_PROVIDERS, signInFieldsOf, signInProvidersFrom,
  type SignInField, type SignInProviderDescription, type SignInRegistration,
} from '../../accounts/lib/sign-in-providers.js';

export interface RootSignInProvider {
  id: string;
  label: string;
  fields: SignInField[];
  register: SignInRegistration;
  redirectUri?: string | undefined;
}

export interface RootSignInChoice {
  id: string;
  label: string;
}

export type RootSignIn =
  | { env: Record<string, string>; chosen: RootSignInChoice[] }
  | { problem: string };

const DOMAIN_NAME = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const isDomainName = (value: string): boolean => DOMAIN_NAME.test(value);

export const rootPublicUrl = (domain: string): string => `https://app.${domain}`;

export function rootSignInProviders(domain: string | undefined, described: readonly SignInProviderDescription[] = SIGN_IN_PROVIDERS): RootSignInProvider[] {
  const named = domain?.trim().toLowerCase();
  const publicUrl = named && isDomainName(named) ? rootPublicUrl(named) : undefined;
  return described.map((description) => ({
    id: description.id,
    label: description.label,
    fields: signInFieldsOf(description),
    register: description.register,
    ...(publicUrl ? { redirectUri: providerCallbackUrl(publicUrl, description.id) } : {}),
  }));
}

export function envValueProblem(name: string, value: string): string | undefined {
  if (/[\r\n]/.test(value)) return `${name} holds a line break`;
  if (value.includes("'")) return `${name} holds a single quote, which root's .env cannot keep as it is`;
  return undefined;
}

export function rootSignInEnv(asked: unknown, described: readonly SignInProviderDescription[] = SIGN_IN_PROVIDERS): RootSignIn {
  if (asked === undefined || asked === null) return { env: {}, chosen: [] };
  if (!Array.isArray(asked)) return { problem: 'Send the sign-in providers as a list of { id, values }.' };
  const env: Record<string, string> = {};
  const seen = new Set<string>();
  for (const entry of asked as unknown[]) {
    const { id, values } = (entry ?? {}) as { id?: unknown; values?: unknown };
    const description = described.find((candidate) => candidate.id === id);
    if (!description) return { problem: `Koala knows no sign-in provider ${JSON.stringify(id)}.` };
    if (seen.has(description.id)) return { problem: `${description.label} is named twice.` };
    seen.add(description.id);
    const given = (values && typeof values === 'object' ? values : {}) as Record<string, unknown>;
    for (const field of signInFieldsOf(description)) {
      const value = given[field.key];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string') return { problem: `${description.label}'s ${field.label.toLowerCase()} is not text.` };
      const trimmed = value.trim();
      if (!trimmed) continue;
      const wrong = envValueProblem(`${description.label}'s ${field.label.toLowerCase()}`, trimmed);
      if (wrong) return { problem: `${wrong}.` };
      env[field.env] = trimmed;
    }
  }
  const { providers, problems } = signInProvidersFrom(env, described);
  if (problems.length) return { problem: `${problems.join('; ')}.` };
  return { env, chosen: providers.map(({ id, label }) => ({ id, label })) };
}

export function signInSecretsOf(env: Readonly<Record<string, string>>, described: readonly SignInProviderDescription[] = SIGN_IN_PROVIDERS): string[] {
  return described
    .flatMap((description) => [description.env.clientId, description.env.clientSecret])
    .map((name) => env[name])
    .filter((value): value is string => Boolean(value));
}

export function missingFromEnvFile(envText: string, wanted: Readonly<Record<string, string>>): string[] {
  const present = new Set(envText.split('\n').map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1]).filter((name): name is string => Boolean(name)));
  return Object.keys(wanted).filter((name) => !present.has(name));
}
