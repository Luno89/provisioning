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
