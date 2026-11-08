import { recordAt } from '../../platform/lib/json-shapes.js';
import type { CloudCredentials } from '../../platform/index.js';
import { credentialEnvOf, credentialsFromEnv, dnsProviderNamed, isDnsProviderName } from './dns-providers.js';
import { allowed, principalOf, type ClaimedUser, type ClaimSettings } from '../../platform/lib/permissions.js';

export const usesOperatorCredentials = (user: ClaimedUser | undefined, claims: ClaimSettings | undefined): boolean =>
  user !== undefined && claims !== undefined && allowed(principalOf(user, claims), 'use-operator-credentials', { kind: 'install' });

export interface ResolvedCredentials {
  mode: 'user' | 'env' | 'none';
  env: Record<string, string>;
}

export type OperatorEnv = Readonly<Record<string, string | undefined>>;

export function credentialsFor(
  provider: string,
  userCreds: CloudCredentials | undefined,
  operatorEnv: OperatorEnv | undefined,
): ResolvedCredentials {
  const fromUser = resolveFromUser(provider, userCreds);
  if (fromUser) return { mode: 'user', env: fromUser };

  const fromEnv = operatorEnv ? resolveFromEnv(provider, operatorEnv) : null;
  if (fromEnv) return { mode: 'env', env: fromEnv };

  return { mode: 'none', env: {} };
}

function resolveFromUser(
  provider: string,
  creds: CloudCredentials | undefined,
): Record<string, string> | null {
  if (!creds) return null;
  if (isDnsProviderName(provider)) return credentialEnvOf(dnsProviderNamed(provider), creds[provider]) ?? null;

  switch (provider) {
    case 'ovh': {
      const o = creds.ovh;
      if (!o?.applicationKey || !o?.applicationSecret || !o?.consumerKey) return null;
      return { OVH_APPLICATION_KEY: o.applicationKey, OVH_APPLICATION_SECRET: o.applicationSecret, OVH_CONSUMER_KEY: o.consumerKey, OVH_SUBSIDIARY: o.subsidiary || 'FR' };
    }
    case 'huggingface': {
      const hf = creds.huggingface;
      if (!hf?.hfToken) return null;
      return { HF_TOKEN: hf.hfToken, HUGGING_FACE_HUB_TOKEN: hf.hfToken };
    }
    case 'github': {
      const gh = creds.github;
      if (!gh?.token) return null;
      return { GITHUB_TOKEN: gh.token, GH_TOKEN: gh.token };
    }
    default:
      return null;
  }
}

function resolveFromEnv(provider: string, env: OperatorEnv): Record<string, string> | null {
  if (isDnsProviderName(provider)) {
    const described = dnsProviderNamed(provider);
    const fields = credentialsFromEnv(described, env);
    return fields ? credentialEnvOf(described, fields) ?? null : null;
  }
  switch (provider) {
    case 'ovh': {
      const key = env.OVH_APPLICATION_KEY;
      const secret = env.OVH_APPLICATION_SECRET;
      const consumer = env.OVH_CONSUMER_KEY;
      if (!key || !secret || !consumer) return null;
      return { OVH_APPLICATION_KEY: key, OVH_APPLICATION_SECRET: secret, OVH_CONSUMER_KEY: consumer, OVH_SUBSIDIARY: env.OVH_SUBSIDIARY || 'FR' };
    }
    case 'huggingface': {
      const token = env.HF_TOKEN || env.VLLM_HF_TOKEN || env.HUGGING_FACE_HUB_TOKEN;
      if (!token) return null;
      return { HF_TOKEN: token, HUGGING_FACE_HUB_TOKEN: token };
    }
    case 'github': {
      const token = env.GITHUB_TOKEN || env.GH_TOKEN;
      if (!token) return null;
      return { GITHUB_TOKEN: token, GH_TOKEN: token };
    }
    default:
      return null;
  }
}

export function credentialFieldsFrom(body: unknown): { fields: Record<string, string> } | { problem: string } {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(recordAt(body))) {
    if (typeof value === 'string') fields[key] = value;
    else if (value) return { problem: `${key} must be text` };
  }
  return { fields };
}
