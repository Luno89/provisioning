import type { CloudCredentials } from '../../platform/index.js';
import { credentialEnvOf, credentialsFromEnv, dnsProviderNamed, isDnsProviderName } from './dns-providers.js';
import { allowed, principalOf, type ClaimedUser, type ClaimSettings } from '../../platform/lib/permissions.js';

export const COMBINED_CLAIMS: ClaimSettings = { role: 'combined' };

export const usesOperatorCredentials = (user: ClaimedUser | undefined, claims: ClaimSettings): boolean =>
  user !== undefined && allowed(principalOf(user, claims), 'use-operator-credentials', { kind: 'install' });

export interface ResolvedCredentials {
  mode: 'user' | 'env' | 'mock';
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

  return { mode: 'mock', env: {} };
}

export function hasCredentialsIn(
  provider: string,
  operatorEnv: OperatorEnv,
  userCreds?: CloudCredentials,
): boolean {
  return credentialsFor(provider, userCreds, operatorEnv).mode !== 'mock';
}

function resolveFromUser(
  provider: string,
  creds: CloudCredentials | undefined,
): Record<string, string> | null {
  if (!creds) return null;
  if (isDnsProviderName(provider)) return credentialEnvOf(dnsProviderNamed(provider), creds[provider]) ?? null;

  switch (provider) {
    case 'aws': {
      const aws = creds.aws;
      if (!aws?.accessKeyId || !aws?.secretAccessKey) return null;
      const env: Record<string, string> = {
        AWS_ACCESS_KEY_ID: aws.accessKeyId,
        AWS_SECRET_ACCESS_KEY: aws.secretAccessKey,
      };
      if (aws.region) env.AWS_DEFAULT_REGION = aws.region;
      return env;
    }
    case 'gcp': {
      const gcp = creds.gcp;
      if (!gcp?.serviceAccountJson) return null;
      const env: Record<string, string> = {
        GOOGLE_CREDENTIALS: gcp.serviceAccountJson,
      };
      if (gcp.projectId) env.GCP_PROJECT = gcp.projectId;
      return env;
    }
    case 'azure': {
      const az = creds.azure;
      if (!az?.clientId || !az?.clientSecret) return null;
      const env: Record<string, string> = {
        ARM_CLIENT_ID: az.clientId,
        ARM_CLIENT_SECRET: az.clientSecret,
      };
      if (az.subscriptionId) env.ARM_SUBSCRIPTION_ID = az.subscriptionId;
      if (az.tenantId) env.ARM_TENANT_ID = az.tenantId;
      return env;
    }
    case 'do': {
      const doC = creds.do;
      if (!doC?.token) return null;
      return { DIGITALOCEAN_TOKEN: doC.token };
    }
    case 'hetzner': {
      const hz = creds.hetzner;
      if (!hz?.token) return null;
      return { HCLOUD_TOKEN: hz.token };
    }
    case 'vultr': {
      const v = creds.vultr;
      if (!v?.token) return null;
      return { VULTR_API_KEY: v.token };
    }
    case 'linode': {
      const l = creds.linode;
      if (!l?.token) return null;
      return { LINODE_TOKEN: l.token };
    }
    case 'scaleway': {
      const sc = creds.scaleway;
      if (!sc?.secretKey) return null;
      const env: Record<string, string> = { SCW_SECRET_KEY: sc.secretKey };
      if (sc.accessKey) env.SCW_ACCESS_KEY = sc.accessKey;
      if (sc.projectId) env.SCW_DEFAULT_PROJECT_ID = sc.projectId;
      return env;
    }
    case 'hostinger': {
      const h = creds.hostinger;
      if (!h?.token) return null;
      return { HOSTINGER_API_TOKEN: h.token };
    }
    case 'ovh': {
      const o = creds.ovh;
      if (!o?.applicationKey || !o?.applicationSecret || !o?.consumerKey) return null;
      return { OVH_APPLICATION_KEY: o.applicationKey, OVH_APPLICATION_SECRET: o.applicationSecret, OVH_CONSUMER_KEY: o.consumerKey, OVH_SUBSIDIARY: o.subsidiary || 'FR' };
    }
    case 'contabo': {
      const c = creds.contabo;
      if (!c?.clientId || !c?.clientSecret || !c?.apiUser || !c?.apiPassword) return null;
      return {
        CNTB_CLIENT_ID: c.clientId,
        CNTB_CLIENT_SECRET: c.clientSecret,
        CNTB_API_USER: c.apiUser,
        CNTB_API_PASSWORD: c.apiPassword,
      };
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
    case 'aws': {
      const keyId = env.AWS_ACCESS_KEY_ID;
      const profile = env.AWS_PROFILE;
      if (!keyId && !profile) return null;
      const out: Record<string, string> = {};
      if (keyId) out.AWS_ACCESS_KEY_ID = keyId;
      if (env.AWS_SECRET_ACCESS_KEY) out.AWS_SECRET_ACCESS_KEY = env.AWS_SECRET_ACCESS_KEY;
      if (profile) out.AWS_PROFILE = profile;
      if (env.AWS_DEFAULT_REGION) out.AWS_DEFAULT_REGION = env.AWS_DEFAULT_REGION;
      return out;
    }
    case 'gcp': {
      const cred = env.GOOGLE_APPLICATION_CREDENTIALS;
      const gcred = env.GOOGLE_CREDENTIALS;
      const proj = env.GCP_PROJECT;
      if (!cred && !gcred && !proj) return null;
      const out: Record<string, string> = {};
      if (cred) out.GOOGLE_APPLICATION_CREDENTIALS = cred;
      if (gcred) out.GOOGLE_CREDENTIALS = gcred;
      if (proj) out.GCP_PROJECT = proj;
      return out;
    }
    case 'azure': {
      const armId = env.ARM_CLIENT_ID;
      const azureId = env.AZURE_CLIENT_ID;
      if (!armId && !azureId) return null;
      const out: Record<string, string> = {};
      if (armId) out.ARM_CLIENT_ID = armId;
      if (azureId) out.AZURE_CLIENT_ID = azureId;
      if (env.ARM_CLIENT_SECRET) out.ARM_CLIENT_SECRET = env.ARM_CLIENT_SECRET;
      if (env.ARM_SUBSCRIPTION_ID) out.ARM_SUBSCRIPTION_ID = env.ARM_SUBSCRIPTION_ID;
      if (env.ARM_TENANT_ID) out.ARM_TENANT_ID = env.ARM_TENANT_ID;
      return out;
    }
    case 'do': {
      const token = env.DIGITALOCEAN_TOKEN || env.DO_TOKEN;
      if (!token) return null;
      return { DIGITALOCEAN_TOKEN: token };
    }
    case 'hetzner': {
      const token = env.HCLOUD_TOKEN || env.HETZNER_TOKEN;
      if (!token) return null;
      return { HCLOUD_TOKEN: token };
    }
    case 'vultr': {
      const token = env.VULTR_API_KEY;
      return token ? { VULTR_API_KEY: token } : null;
    }
    case 'linode': {
      const token = env.LINODE_TOKEN;
      return token ? { LINODE_TOKEN: token } : null;
    }
    case 'scaleway': {
      const secret = env.SCW_SECRET_KEY;
      if (!secret) return null;
      const out: Record<string, string> = { SCW_SECRET_KEY: secret };
      if (env.SCW_ACCESS_KEY) out.SCW_ACCESS_KEY = env.SCW_ACCESS_KEY;
      if (env.SCW_DEFAULT_PROJECT_ID) out.SCW_DEFAULT_PROJECT_ID = env.SCW_DEFAULT_PROJECT_ID;
      return out;
    }
    case 'hostinger': {
      const token = env.HOSTINGER_API_TOKEN;
      return token ? { HOSTINGER_API_TOKEN: token } : null;
    }
    case 'ovh': {
      const key = env.OVH_APPLICATION_KEY;
      const secret = env.OVH_APPLICATION_SECRET;
      const consumer = env.OVH_CONSUMER_KEY;
      if (!key || !secret || !consumer) return null;
      return { OVH_APPLICATION_KEY: key, OVH_APPLICATION_SECRET: secret, OVH_CONSUMER_KEY: consumer, OVH_SUBSIDIARY: env.OVH_SUBSIDIARY || 'FR' };
    }
    case 'contabo': {
      const id = env.CNTB_CLIENT_ID;
      const secret = env.CNTB_CLIENT_SECRET;
      const user = env.CNTB_API_USER;
      const pass = env.CNTB_API_PASSWORD;
      if (!id || !secret || !user || !pass) return null;
      return { CNTB_CLIENT_ID: id, CNTB_CLIENT_SECRET: secret, CNTB_API_USER: user, CNTB_API_PASSWORD: pass };
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
