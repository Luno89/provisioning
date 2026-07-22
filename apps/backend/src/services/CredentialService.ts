/**
 * CredentialService
 *
 * Manages per-user cloud provider credentials with AES-256-GCM encryption
 * at rest. Provides CRUD operations plus the resolution chain used by
 * activities and workflows.
 */
import type { Database } from '../lib/db-interface.js';
import type { CloudCredentials, CloudProvider, UserMetadata } from '../lib/types.js';
import { encryptValue, decryptValue, maskSecret } from '../lib/crypto.js';
import { resolveCloudCredentials, type ResolvedCredentials } from '../lib/credential-resolver.js';

/** Fields that are considered sensitive and must be encrypted at rest */
const SENSITIVE_FIELDS: Record<string, string[]> = {
  aws: ['accessKeyId', 'secretAccessKey'],
  gcp: ['serviceAccountJson'],
  azure: ['clientId', 'clientSecret'],
  do: ['token'],
  huggingface: ['hfToken'],
  github: ['token'],
};

/** Fields that are stored in plaintext (non-sensitive metadata) */
const PLAINTEXT_FIELDS: Record<string, string[]> = {
  aws: ['region'],
  gcp: ['projectId'],
  azure: ['subscriptionId', 'tenantId'],
  do: [],
  huggingface: ['defaultModel'],
  github: ['username'],
};

export interface ProviderStatus {
  provider: CloudProvider;
  label: string;
  configured: boolean;
  source?: 'user' | 'env';
  summary?: Record<string, string>; // masked values for display
}

export class CredentialService {
  constructor(
    private readonly db: Database,
    private readonly masterKey: string,
  ) {}

  /**
   * Validate credentials live against provider API.
   */
  async validateCredentials(
    provider: string,
    creds: Record<string, string>,
  ): Promise<{ valid: boolean; message: string; details?: any }> {
    try {
      if (provider === 'huggingface') {
        const token = creds.hfToken || creds.token;
        if (!token) return { valid: false, message: 'Hugging Face Access Token is required.' };
        const res = await fetch('https://huggingface.co/api/whoami-v2', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          return { valid: false, message: `Invalid token or unauthorized (HTTP ${res.status}).` };
        }
        const data = await res.json();
        return { valid: true, message: `Authenticated as Hugging Face user @${data.name || data.fullname || 'user'}`, details: data };
      }

      if (provider === 'github') {
        const token = creds.token;
        if (!token) return { valid: false, message: 'GitHub Personal Access Token is required.' };
        const res = await fetch('https://api.github.com/user', {
          headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'Antigravity-Provisioning' },
        });
        if (!res.ok) {
          return { valid: false, message: `Invalid token or unauthorized (HTTP ${res.status}).` };
        }
        const data = await res.json();
        return { valid: true, message: `Authenticated as GitHub user @${data.login}`, details: data };
      }

      if (provider === 'aws') {
        if (!creds.accessKeyId || !creds.secretAccessKey) {
          return { valid: false, message: 'AWS Access Key ID and Secret Access Key are required.' };
        }
        if (!creds.accessKeyId.startsWith('AKIA') && !creds.accessKeyId.startsWith('ASIA')) {
          return { valid: false, message: 'AWS Access Key ID format appears invalid.' };
        }
        return { valid: true, message: 'AWS credentials format validated.' };
      }

      if (provider === 'gcp') {
        if (!creds.serviceAccountJson) {
          return { valid: false, message: 'GCP Service Account JSON is required.' };
        }
        try {
          const parsed = JSON.parse(creds.serviceAccountJson);
          if (parsed.type !== 'service_account' || !parsed.project_id) {
            return { valid: false, message: 'Invalid GCP Service Account JSON structure.' };
          }
          return { valid: true, message: `Validated GCP Service Account for project "${parsed.project_id}"` };
        } catch {
          return { valid: false, message: 'Service Account JSON is not valid JSON.' };
        }
      }

      if (provider === 'azure') {
        if (!creds.clientId || !creds.clientSecret) {
          return { valid: false, message: 'Azure Client ID and Client Secret are required.' };
        }
        return { valid: true, message: 'Azure SP credentials format validated.' };
      }

      if (provider === 'do') {
        if (!creds.token) return { valid: false, message: 'DigitalOcean API Token is required.' };
        const res = await fetch('https://api.digitalocean.com/v2/account', {
          headers: { Authorization: `Bearer ${creds.token}` },
        });
        if (!res.ok) {
          return { valid: false, message: `Invalid token or unauthorized (HTTP ${res.status}).` };
        }
        const data = await res.json();
        return { valid: true, message: `Authenticated as DigitalOcean account (${data.account?.email || 'active'})` };
      }

      return { valid: true, message: 'Credentials formatted.' };
    } catch (err: any) {
      return { valid: false, message: `Validation failed: ${err?.message || 'Network error'}` };
    }
  }

  /**
   * Get the status of all supported cloud providers for a user.
   */
  async getConfiguredProviders(userId: string): Promise<ProviderStatus[]> {
    const user = await this.db.getUserById(userId);

    const providers: { key: CloudProvider; label: string }[] = [
      { key: 'huggingface', label: 'Hugging Face' },
      { key: 'github', label: 'GitHub' },
      { key: 'aws', label: 'Amazon Web Services' },
      { key: 'gcp', label: 'Google Cloud Platform' },
      { key: 'azure', label: 'Microsoft Azure' },
      { key: 'do', label: 'DigitalOcean' },
    ];

    return providers.map(({ key, label }) => {
      const resolved = resolveCloudCredentials(key, user?.credentials ? this.decryptAll(user.credentials, key) : undefined);

      if (resolved.mode === 'mock') {
        return { provider: key, label, configured: false };
      }

      // Build a masked summary for display
      const summary: Record<string, string> = {};
      for (const [k, v] of Object.entries(resolved.env)) {
        summary[k] = maskSecret(v);
      }

      return { provider: key, label, configured: true, source: resolved.mode, summary };
    });
  }

  /**
   * Get the masked credential details for a specific provider.
   */
  async getCredentials(userId: string, provider: CloudProvider): Promise<Record<string, string> | null> {
    const user = await this.db.getUserById(userId);
    if (!user?.credentials) return null;

    const providerCreds = user.credentials[provider];
    if (!providerCreds) return null;

    const sensitive = SENSITIVE_FIELDS[provider] || [];
    const result: Record<string, string> = {};

    for (const [key, value] of Object.entries(providerCreds)) {
      if (typeof value !== 'string') continue;
      if (sensitive.includes(key)) {
        try {
          const decrypted = decryptValue(value, this.masterKey);
          result[key] = maskSecret(decrypted);
        } catch {
          result[key] = '****';
        }
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  /**
   * Save credentials for a provider. Encrypts sensitive fields before storage.
   */
  async saveCredentials(
    userId: string,
    provider: CloudProvider,
    creds: Record<string, string>,
  ): Promise<void> {
    const user = await this.db.getUserById(userId);
    if (!user) throw new Error('User not found');

    const sensitive = SENSITIVE_FIELDS[provider] || [];
    const plaintext = PLAINTEXT_FIELDS[provider] || [];
    const encrypted: Record<string, string> = {};

    for (const [key, value] of Object.entries(creds)) {
      if (!value) continue;
      if (sensitive.includes(key)) {
        encrypted[key] = encryptValue(value, this.masterKey);
      } else if (plaintext.includes(key)) {
        encrypted[key] = value;
      }
      // Ignore unknown fields
    }

    if (!user.credentials) {
      user.credentials = {};
    }
    (user.credentials as any)[provider] = encrypted;

    await this.db.saveUser(user);
  }

  /**
   * Remove stored credentials for a provider.
   */
  async deleteCredentials(userId: string, provider: CloudProvider): Promise<void> {
    const user = await this.db.getUserById(userId);
    if (!user) throw new Error('User not found');

    if (user.credentials) {
      delete (user.credentials as any)[provider];
      await this.db.saveUser(user);
    }
  }

  /**
   * Resolve credentials for a provider using the full resolution chain:
   *   1. User's encrypted credentials (decrypted)
   *   2. process.env
   *   3. null → mock cloud mode
   */
  async resolveCredentials(userId: string, provider: string): Promise<ResolvedCredentials> {
    const user = await this.db.getUserById(userId);
    const decrypted = user?.credentials ? this.decryptAll(user.credentials, provider) : undefined;
    return resolveCloudCredentials(provider, decrypted);
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Decrypt all sensitive fields for a specific provider within a CloudCredentials blob.
   * Returns a new CloudCredentials object with plaintext values (for resolution).
   */
  private decryptAll(credentials: CloudCredentials, provider: string): CloudCredentials {
    const providerCreds = (credentials as any)[provider];
    if (!providerCreds) return {};

    const sensitive = SENSITIVE_FIELDS[provider] || [];
    const decrypted: Record<string, string> = {};

    for (const [key, value] of Object.entries(providerCreds)) {
      if (typeof value !== 'string') continue;
      if (sensitive.includes(key)) {
        try {
          decrypted[key] = decryptValue(value, this.masterKey);
        } catch {
          // Corrupted or wrong key — skip this field
          continue;
        }
      } else {
        decrypted[key] = value;
      }
    }

    return { [provider]: decrypted } as CloudCredentials;
  }
}
