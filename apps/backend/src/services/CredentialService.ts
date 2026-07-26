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

/**
 * Provider API responses are unvalidated external JSON, and `Response.json()` is typed `unknown`.
 * We only ever read a couple of display fields off these, so this narrows just enough for those
 * reads to typecheck — deliberately without pretending the shape has been validated.
 */
async function readJson(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

/** Fields that are considered sensitive and must be encrypted at rest */
const SENSITIVE_FIELDS: Record<string, string[]> = {
  aws: ['accessKeyId', 'secretAccessKey'],
  gcp: ['serviceAccountJson'],
  azure: ['clientId', 'clientSecret'],
  do: ['token'],
  hetzner: ['token'],
  huggingface: ['hfToken'],
  github: ['token'],
  googledrive: ['refreshToken', 'backupPassword'],
};

/** Fields that are stored in plaintext (non-sensitive metadata) */
const PLAINTEXT_FIELDS: Record<string, string[]> = {
  aws: ['region'],
  gcp: ['projectId'],
  azure: ['subscriptionId', 'tenantId'],
  do: [],
  hetzner: [],
  huggingface: ['defaultModel'],
  github: ['username'],
  googledrive: ['email'],
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
        const data = await readJson(res);
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
        const data = await readJson(res);
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
        const data = await readJson(res);
        return { valid: true, message: `Authenticated as DigitalOcean account (${data.account?.email || 'active'})` };
      }

      if (provider === 'hetzner') {
        if (!creds.token) return { valid: false, message: 'Hetzner Cloud API Token is required.' };
        // Hetzner Cloud has no "account" endpoint — a token is scoped to a single project, so
        // listing that project's servers is the cheapest call that proves the token both parses
        // and is authorised. 401 here is the "bad token" signal; anything else is surfaced as-is.
        const res = await fetch('https://api.hetzner.cloud/v1/servers?per_page=1', {
          headers: { Authorization: `Bearer ${creds.token}` },
        });
        if (res.status === 401 || res.status === 403) {
          return { valid: false, message: `Invalid token or unauthorized (HTTP ${res.status}).` };
        }
        if (!res.ok) {
          return { valid: false, message: `Hetzner Cloud API returned HTTP ${res.status}.` };
        }
        const data = await readJson(res);
        const total = data?.meta?.pagination?.total_entries;
        return {
          valid: true,
          message: `Authenticated against Hetzner Cloud project${
            typeof total === 'number' ? ` (${total} existing server${total === 1 ? '' : 's'})` : ''
          }.`,
        };
      }

      if (provider === 'googledrive') {
        const refreshToken = creds.refreshToken;
        if (!refreshToken) return { valid: false, message: 'Not connected — use "Connect with Google" first.' };
        const clientId = process.env.GOOGLE_CLIENT_ID;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          return { valid: false, message: 'GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are not set on the server.' };
        }
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
        });
        if (!tokenRes.ok) {
          return { valid: false, message: `Google Drive refresh token is no longer valid (HTTP ${tokenRes.status}) — reconnect.` };
        }
        const { access_token } = await readJson(tokenRes);
        const aboutRes = await fetch('https://www.googleapis.com/drive/v3/about?fields=user', {
          headers: { Authorization: `Bearer ${access_token}` },
        });
        if (!aboutRes.ok) {
          return { valid: false, message: `Drive API check failed (HTTP ${aboutRes.status}).` };
        }
        const about = await readJson(aboutRes);
        return { valid: true, message: `Connected to Google Drive as ${about.user?.emailAddress || 'unknown account'}` };
      }

      return { valid: true, message: 'Credentials formatted.' };
    } catch (err: any) {
      return { valid: false, message: `Validation failed: ${err?.message || 'Network error'}` };
    }
  }

  /**
   * "Test Connection" for Google Drive can't reuse validateCredentials(provider, req.body)
   * directly like the other providers — the frontend never has the plaintext refreshToken to
   * send (it's set once via the OAuth callback, not typed into a form), so this pulls it from
   * storage first.
   */
  async testGoogleDriveConnection(userId: string): Promise<{ valid: boolean; message: string; details?: any }> {
    const user = await this.db.getUserById(userId);
    const decrypted = user?.credentials ? this.decryptAll(user.credentials, 'googledrive') : undefined;
    const refreshToken = (decrypted as any)?.googledrive?.refreshToken || '';
    return this.validateCredentials('googledrive', { refreshToken });
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
      { key: 'hetzner', label: 'Hetzner Cloud' },
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

    for (const [key, rawValue] of Object.entries(creds)) {
      if (!rawValue) continue;
      // A pasted token with a trailing space/newline (common clipboard artifact) encrypts and
      // decrypts fine, and passes every validateCredentials() check here since those go through
      // fetch()/curl, which tolerate it — but a strict HTTP client downstream (confirmed live:
      // Python's httpx, used by TabbyAPI's own downloader) rejects it outright as an illegal
      // header value, failing every request with no indication the token itself was the problem.
      const value = rawValue.trim();
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
    // Merge rather than replace: googledrive in particular is written incrementally by two
    // independent flows (the OAuth callback sets refreshToken+email, the account-page form sets
    // backupPassword separately) — replacing outright would let the second call wipe the first.
    // Harmless for the other providers, whose forms always submit every field together anyway.
    const existing = (user.credentials as any)[provider] || {};
    (user.credentials as any)[provider] = { ...existing, ...encrypted };

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
