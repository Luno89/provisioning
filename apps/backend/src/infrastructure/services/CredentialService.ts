import { at, type CloudCredentials, type CloudProvider, type Database, decryptValue, encryptValue, isRecord, maskSecret, type SecretKey, textAt } from '../../platform/index.js';
import { usesOperatorCredentials, type ResolvedCredentials } from '../lib/credential-resolver.js';
import { resolveCloudCredentials } from './cloud-credentials.js';
import { OVH_SUBSIDIARIES } from '../lib/vps-catalog/adapters.js';
import { credentialsFromEnv, dnsProviderNamed, DNS_PROVIDERS, isDnsProviderName, plainFieldsOf, secretFieldsOf } from '../lib/dns-providers.js';
import { DnsProviders } from './dns/DnsProviders.js';
import { OvhClient, type FetchLike } from './OvhClient.js';
import type { ClaimSettings } from '../../platform/index.js';

async function readJson(res: Response): Promise<unknown> {
  return res.json();
}

const SENSITIVE_FIELDS: Record<string, string[]> = {
  ovh: ['applicationKey', 'applicationSecret', 'consumerKey'],
  huggingface: ['hfToken'],
  artificialanalysis: ['apiKey'],
  github: ['token'],
  googledrive: ['refreshToken', 'backupPassword'],
  ...Object.fromEntries(DNS_PROVIDERS.map((provider) => [provider.name, secretFieldsOf(provider)])),
};

const PLAINTEXT_FIELDS: Record<string, string[]> = {
  ovh: ['subsidiary'],
  huggingface: ['defaultModel'],
  artificialanalysis: [],
  github: ['username'],
  googledrive: ['email'],
  ...Object.fromEntries(DNS_PROVIDERS.map((provider) => [provider.name, plainFieldsOf(provider)])),
};

export interface ProviderStatus {
  provider: CloudProvider;
  label: string;
  configured: boolean;
  source?: 'user' | 'env';
  summary?: Record<string, string>;
  unreadable?: string;
}

export class UnreadableCredential extends Error {
  constructor(readonly provider: string, readonly field: string) {
    super(`your ${provider} ${field} was saved under a key this Koala no longer holds; enter it again under Cloud providers`);
    this.name = 'UnreadableCredential';
  }
}

export class CredentialService {
  constructor(
    private readonly db: Database,
    private readonly masterKey: SecretKey,
    private readonly claims?: ClaimSettings | undefined,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly dns: DnsProviders = new DnsProviders(fetchImpl),
  ) {}

  async validateCredentials(
    provider: string,
    creds: Record<string, string>,
  ): Promise<{ valid: boolean; message: string; details?: unknown }> {
    try {
      if (isDnsProviderName(provider)) return await this.dns.validate(provider, creds);

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
        return { valid: true, message: `Authenticated as Hugging Face user @${textAt(data, 'name') || textAt(data, 'fullname') || 'user'}`, details: data };
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
        return { valid: true, message: `Authenticated as GitHub user @${textAt(data, 'login') ?? ''}`, details: data };
      }

      if (provider === 'ovh') {
        const { applicationKey, applicationSecret, consumerKey } = creds;
        const subsidiary = String(creds.subsidiary ?? '').trim().toUpperCase();
        if (!applicationKey || !applicationSecret || !consumerKey || !subsidiary) {
          return { valid: false, message: 'OVHcloud needs the application key, application secret, consumer key and your account\'s subsidiary (for example AU, FR or CA).' };
        }
        if (!OVH_SUBSIDIARIES.includes(subsidiary)) {
          return { valid: false, message: `${subsidiary} is not an OVHcloud subsidiary; known ones are ${OVH_SUBSIDIARIES.join(', ')}.` };
        }
        try {
          const me = await new OvhClient({ applicationKey, applicationSecret, consumerKey, subsidiary }, this.fetchImpl).get<{ nichandle?: string; ovhSubsidiary?: string; currency?: { code?: string } }>('/me');
          if (me.ovhSubsidiary && me.ovhSubsidiary !== subsidiary) {
            return { valid: false, message: `These keys belong to an OVHcloud ${me.ovhSubsidiary} account, not ${subsidiary}; set the subsidiary to ${me.ovhSubsidiary}.` };
          }
          return { valid: true, message: `Signed in to OVHcloud as ${me.nichandle ?? 'your account'} (${subsidiary}${me.currency?.code ? `, ${me.currency.code}` : ''}).` };
        } catch (error) {
          return { valid: false, message: (error as Error).message };
        }
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
        const accessToken = textAt(await readJson(tokenRes), 'access_token');
        const aboutRes = await fetch('https://www.googleapis.com/drive/v3/about?fields=user', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!aboutRes.ok) {
          return { valid: false, message: `Drive API check failed (HTTP ${aboutRes.status}).` };
        }
        const about = await readJson(aboutRes);
        return { valid: true, message: `Connected to Google Drive as ${textAt(about, 'user', 'emailAddress') || 'unknown account'}` };
      }

      return { valid: true, message: 'Credentials formatted.' };
    } catch (err) {
      return { valid: false, message: `Validation failed: ${(err as Error | undefined)?.message || 'Network error'}` };
    }
  }

  async testGoogleDriveConnection(userId: string): Promise<{ valid: boolean; message: string; details?: unknown }> {
    const user = await this.db.accounts.getUserById(userId);
    const decrypted = user?.credentials ? this.decryptAll(user.credentials, 'googledrive') : undefined;
    const refreshToken = decrypted?.googledrive?.refreshToken || '';
    return this.validateCredentials('googledrive', { refreshToken });
  }

  async getConfiguredProviders(userId: string): Promise<ProviderStatus[]> {
    const user = await this.db.accounts.getUserById(userId);

    const providers: { key: CloudProvider; label: string }[] = [
      { key: 'huggingface', label: 'Hugging Face' },
      { key: 'artificialanalysis', label: 'Artificial Analysis' },
      { key: 'github', label: 'GitHub' },
      { key: 'ovh', label: 'OVHcloud' },
      ...DNS_PROVIDERS.map((provider) => ({ key: provider.name as CloudProvider, label: provider.label })),
    ];

    return providers.map(({ key, label }) => {
      let stored: CloudCredentials | undefined;
      try {
        stored = user?.credentials ? this.decryptAll(user.credentials, key) : undefined;
      } catch (err) {
        if (!(err instanceof UnreadableCredential)) throw err;
        return { provider: key, label, configured: false, unreadable: err.message };
      }
      const resolved = resolveCloudCredentials(key, stored, usesOperatorCredentials(user, this.claims));

      if (resolved.mode === 'none') {
        return { provider: key, label, configured: false };
      }

      const summary: Record<string, string> = {};
      for (const [k, v] of Object.entries(resolved.env)) {
        summary[k] = maskSecret(v);
      }

      return { provider: key, label, configured: true, source: resolved.mode, summary };
    });
  }

  async getCredentials(userId: string, provider: CloudProvider): Promise<Record<string, string> | null> {
    const user = await this.db.accounts.getUserById(userId);
    if (!user?.credentials) return null;

    const providerCreds = user.credentials[provider];
    if (!providerCreds) return null;

    const sensitive = SENSITIVE_FIELDS[provider] || [];
    const result: Record<string, string> = {};

    for (const [key, value] of Object.entries(providerCreds)) {
      if (typeof value !== 'string') continue;
      if (sensitive.includes(key)) {
        result[key] = maskSecret(this.decrypted(value, provider, key));
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  async saveCredentials(
    userId: string,
    provider: CloudProvider,
    creds: Record<string, string>,
  ): Promise<void> {
    const user = await this.db.accounts.getUserById(userId);
    if (!user) throw new Error('User not found');

    const sensitive = SENSITIVE_FIELDS[provider] || [];
    const plaintext = PLAINTEXT_FIELDS[provider] || [];
    const encrypted: Record<string, string> = {};

    for (const [key, rawValue] of Object.entries(creds)) {
      if (!rawValue) continue;
      const value = rawValue.trim();
      if (!value) continue;
      if (sensitive.includes(key)) {
        encrypted[key] = encryptValue(value, this.masterKey);
      } else if (plaintext.includes(key)) {
        encrypted[key] = value;
      }
    }

    if (!user.credentials) {
      user.credentials = {};
    }
    const existing = at(user.credentials, provider);
    Object.assign(user.credentials, { [provider]: { ...(isRecord(existing) ? existing : {}), ...encrypted } });

    await this.db.accounts.saveUser(user);
  }

  async deleteCredentials(userId: string, provider: CloudProvider): Promise<void> {
    const user = await this.db.accounts.getUserById(userId);
    if (!user) throw new Error('User not found');

    if (user.credentials) {
      Reflect.deleteProperty(user.credentials, provider);
      await this.db.accounts.saveUser(user);
    }
  }

  async dnsCredentialsOf(userId: string, provider: string): Promise<Record<string, string> | undefined> {
    if (!isDnsProviderName(provider)) return undefined;
    const resolved = await this.resolveCredentials(userId, provider);
    return resolved.mode === 'none' ? undefined : credentialsFromEnv(dnsProviderNamed(provider), resolved.env);
  }

  async resolveCredentials(userId: string, provider: string): Promise<ResolvedCredentials> {
    const user = await this.db.accounts.getUserById(userId);
    const decrypted = user?.credentials ? this.decryptAll(user.credentials, provider) : undefined;
    return resolveCloudCredentials(provider, decrypted, usesOperatorCredentials(user, this.claims));
  }

  private decrypted(value: string, provider: string, field: string): string {
    try {
      return decryptValue(value, this.masterKey);
    } catch {
      throw new UnreadableCredential(provider, field);
    }
  }

  private decryptAll(credentials: CloudCredentials, provider: string): CloudCredentials {
    const providerCreds = at(credentials, provider);
    if (!isRecord(providerCreds)) return {};

    const sensitive = SENSITIVE_FIELDS[provider] || [];
    const decrypted: Record<string, string> = {};

    for (const [key, value] of Object.entries(providerCreds)) {
      if (typeof value !== 'string') continue;
      if (sensitive.includes(key)) {
        decrypted[key] = this.decrypted(value, provider, key);
      } else {
        decrypted[key] = value;
      }
    }

    return { [provider]: decrypted } as CloudCredentials;
  }
}
