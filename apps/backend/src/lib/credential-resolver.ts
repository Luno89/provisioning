/**
 * credential-resolver.ts
 *
 * Centralised credential resolution that replaces the 6+ duplicated
 * `hasCloudCredentials()` functions scattered across activities and services.
 *
 * Resolution chain:  user-stored credentials → process.env → mock mode.
 */
import type { CloudCredentials } from './types.js';

export interface ResolvedCredentials {
  /** Where the credentials came from */
  mode: 'user' | 'env' | 'mock';
  /** Environment variable key-value pairs to inject into subprocess env */
  env: Record<string, string>;
}

/**
 * Resolve cloud credentials for a given provider.
 *
 * @param provider  - one of 'aws' | 'gcp' | 'azure' | 'do'
 * @param userCreds - the user's decrypted CloudCredentials object (or undefined)
 * @returns ResolvedCredentials with mode and env vars
 */
export function resolveCloudCredentials(
  provider: string,
  userCreds: CloudCredentials | undefined,
): ResolvedCredentials {
  // 1. Try user-stored credentials
  const fromUser = resolveFromUser(provider, userCreds);
  if (fromUser) return { mode: 'user', env: fromUser };

  // 2. Try process.env
  const fromEnv = resolveFromEnv(provider);
  if (fromEnv) return { mode: 'env', env: fromEnv };

  // 3. No credentials → mock cloud mode
  return { mode: 'mock', env: {} };
}

/**
 * Quick check: does this provider have any credentials available
 * (either from the user store or process.env)?
 */
export function hasCloudCredentials(
  provider: string,
  userCreds?: CloudCredentials,
): boolean {
  return resolveCloudCredentials(provider, userCreds).mode !== 'mock';
}

// ── Internal helpers ──────────────────────────────────────────────────────

function resolveFromUser(
  provider: string,
  creds: CloudCredentials | undefined,
): Record<string, string> | null {
  if (!creds) return null;

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
      // HCLOUD_TOKEN is what the hetznercloud/hcloud Terraform provider reads by default, so the
      // hetzner-vm construct needs no explicit `token` argument.
      return { HCLOUD_TOKEN: hz.token };
    }
    // Env var names below match each provider's own official Terraform provider / CLI, so a
    // credential resolved here works unmodified in a CDKTF subprocess.
    case 'cloudflare': {
      const cf = creds.cloudflare;
      if (!cf?.token) return null;
      return { CLOUDFLARE_API_TOKEN: cf.token, ...(cf.zone ? { CLOUDFLARE_ZONE: cf.zone } : {}) };
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

function resolveFromEnv(provider: string): Record<string, string> | null {
  switch (provider) {
    case 'aws': {
      const keyId = process.env.AWS_ACCESS_KEY_ID;
      const profile = process.env.AWS_PROFILE;
      if (!keyId && !profile) return null;
      const env: Record<string, string> = {};
      if (keyId) env.AWS_ACCESS_KEY_ID = keyId;
      if (process.env.AWS_SECRET_ACCESS_KEY) env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
      if (profile) env.AWS_PROFILE = profile;
      if (process.env.AWS_DEFAULT_REGION) env.AWS_DEFAULT_REGION = process.env.AWS_DEFAULT_REGION;
      return env;
    }
    case 'gcp': {
      const cred = process.env.GOOGLE_APPLICATION_CREDENTIALS;
      const gcred = process.env.GOOGLE_CREDENTIALS;
      const proj = process.env.GCP_PROJECT;
      if (!cred && !gcred && !proj) return null;
      const env: Record<string, string> = {};
      if (cred) env.GOOGLE_APPLICATION_CREDENTIALS = cred;
      if (gcred) env.GOOGLE_CREDENTIALS = gcred;
      if (proj) env.GCP_PROJECT = proj;
      return env;
    }
    case 'azure': {
      const armId = process.env.ARM_CLIENT_ID;
      const azureId = process.env.AZURE_CLIENT_ID;
      if (!armId && !azureId) return null;
      const env: Record<string, string> = {};
      if (armId) env.ARM_CLIENT_ID = armId;
      if (azureId) env.AZURE_CLIENT_ID = azureId;
      if (process.env.ARM_CLIENT_SECRET) env.ARM_CLIENT_SECRET = process.env.ARM_CLIENT_SECRET;
      if (process.env.ARM_SUBSCRIPTION_ID) env.ARM_SUBSCRIPTION_ID = process.env.ARM_SUBSCRIPTION_ID;
      if (process.env.ARM_TENANT_ID) env.ARM_TENANT_ID = process.env.ARM_TENANT_ID;
      return env;
    }
    case 'do': {
      const token = process.env.DIGITALOCEAN_TOKEN || process.env.DO_TOKEN;
      if (!token) return null;
      return { DIGITALOCEAN_TOKEN: token };
    }
    case 'hetzner': {
      const token = process.env.HCLOUD_TOKEN || process.env.HETZNER_TOKEN;
      if (!token) return null;
      return { HCLOUD_TOKEN: token };
    }
    case 'cloudflare': {
      // CLOUDFLARE_API_TOKEN is the name Cloudflare's own tooling and the Terraform provider read.
      const token = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
      if (!token) return null;
      return { CLOUDFLARE_API_TOKEN: token, ...(process.env.CLOUDFLARE_ZONE ? { CLOUDFLARE_ZONE: process.env.CLOUDFLARE_ZONE } : {}) };
    }
    case 'vultr': {
      const token = process.env.VULTR_API_KEY;
      return token ? { VULTR_API_KEY: token } : null;
    }
    case 'linode': {
      const token = process.env.LINODE_TOKEN;
      return token ? { LINODE_TOKEN: token } : null;
    }
    case 'scaleway': {
      const secret = process.env.SCW_SECRET_KEY;
      if (!secret) return null;
      const env: Record<string, string> = { SCW_SECRET_KEY: secret };
      if (process.env.SCW_ACCESS_KEY) env.SCW_ACCESS_KEY = process.env.SCW_ACCESS_KEY;
      if (process.env.SCW_DEFAULT_PROJECT_ID) env.SCW_DEFAULT_PROJECT_ID = process.env.SCW_DEFAULT_PROJECT_ID;
      return env;
    }
    case 'hostinger': {
      const token = process.env.HOSTINGER_API_TOKEN;
      return token ? { HOSTINGER_API_TOKEN: token } : null;
    }
    case 'contabo': {
      const id = process.env.CNTB_CLIENT_ID;
      const secret = process.env.CNTB_CLIENT_SECRET;
      const user = process.env.CNTB_API_USER;
      const pass = process.env.CNTB_API_PASSWORD;
      if (!id || !secret || !user || !pass) return null;
      return { CNTB_CLIENT_ID: id, CNTB_CLIENT_SECRET: secret, CNTB_API_USER: user, CNTB_API_PASSWORD: pass };
    }
    case 'huggingface': {
      const token = process.env.HF_TOKEN || process.env.VLLM_HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN;
      if (!token) return null;
      return { HF_TOKEN: token, HUGGING_FACE_HUB_TOKEN: token };
    }
    case 'github': {
      const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      if (!token) return null;
      return { GITHUB_TOKEN: token, GH_TOKEN: token };
    }
    default:
      return null;
  }
}
