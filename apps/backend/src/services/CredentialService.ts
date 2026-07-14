/**
 * CredentialService
 *
 * Manages per-user cloud provider credentials with AES-256-GCM encryption
 * at rest. Provides CRUD operations plus the resolution chain used by
 * activities and workflows.
 */
import type { LocalDB } from '../lib/db.js';
import type { CloudCredentials, CloudProvider, UserMetadata } from '../lib/types.js';
import { encryptValue, decryptValue, maskSecret } from '../lib/crypto.js';
import { resolveCloudCredentials, type ResolvedCredentials } from '../lib/credential-resolver.js';

/** Fields that are considered sensitive and must be encrypted at rest */
const SENSITIVE_FIELDS: Record<string, string[]> = {
  aws: ['accessKeyId', 'secretAccessKey'],
  gcp: ['serviceAccountJson'],
  azure: ['clientId', 'clientSecret'],
  do: ['token'],
};

/** Fields that are stored in plaintext (non-sensitive metadata) */
const PLAINTEXT_FIELDS: Record<string, string[]> = {
  aws: ['region'],
  gcp: ['projectId'],
  azure: ['subscriptionId', 'tenantId'],
  do: [],
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
    private readonly db: LocalDB,
    private readonly masterKey: string,
  ) {}

  /**
   * Get the status of all supported cloud providers for a user.
   */
  async getConfiguredProviders(userId: string): Promise<ProviderStatus[]> {
    const user = await this.db.getUserById(userId);

    const providers: { key: CloudProvider; label: string }[] = [
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
