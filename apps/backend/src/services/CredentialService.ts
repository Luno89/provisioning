import type { Database } from '../lib/db-interface.js';
import type { CloudCredentials, CloudProvider, UserMetadata } from '../lib/types.js';
import { encryptValue, decryptValue, maskSecret } from '../lib/crypto.js';
import { resolveCloudCredentials, type ResolvedCredentials } from '../lib/credential-resolver.js';

async function readJson(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

const SENSITIVE_FIELDS: Record<string, string[]> = {
  aws: ['accessKeyId', 'secretAccessKey'],
  gcp: ['serviceAccountJson'],
  azure: ['clientId', 'clientSecret'],
  do: ['token'],
  hetzner: ['token'],
  cloudflare: ['token'],
  vultr: ['token'],
  linode: ['token'],
  scaleway: ['secretKey'],
  hostinger: ['token'],
  contabo: ['clientId', 'clientSecret', 'apiPassword'],
  huggingface: ['hfToken'],
  github: ['token'],
  googledrive: ['refreshToken', 'backupPassword'],
};

const PLAINTEXT_FIELDS: Record<string, string[]> = {
  aws: ['region'],
  gcp: ['projectId'],
  azure: ['subscriptionId', 'tenantId'],
  do: [],
  hetzner: [],
  cloudflare: ['zone'],
  vultr: [],
  linode: [],
  scaleway: ['accessKey', 'projectId'],
  hostinger: [],
  contabo: ['apiUser'],
  huggingface: ['defaultModel'],
  github: ['username'],
  googledrive: ['email'],
};

export interface ProviderStatus {
  provider: CloudProvider;
  label: string;
  configured: boolean;
  source?: 'user' | 'env';
  summary?: Record<string, string>;
}

export class CredentialService {
  constructor(
    private readonly db: Database,
    private readonly masterKey: string,
  ) {}

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

      if (provider === 'cloudflare') {
        const token = String(creds.token ?? '').trim();
        if (!token) return { valid: false, message: 'Cloudflare API Token is required.' };
        if (/\s/.test(token)) {
          return { valid: false, message: 'The token contains a space or line break — it looks like more than just the token was pasted.' };
        }

        const res = await fetch('https://api.cloudflare.com/client/v4/zones', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await readJson(res);

        if (!res.ok || data?.success !== true) {
          const detail = data?.errors?.[0]?.error_chain?.[0]?.message
            ?? data?.errors?.[0]?.message
            ?? `HTTP ${res.status}`;
          const hint = /Authorization header/i.test(String(detail))
            ? ' Make sure this is a scoped API token (Zone → DNS → Edit), not the Global API Key.'
            : '';
          return { valid: false, message: `Cloudflare rejected the token: ${detail}.${hint}` };
        }

        const zones: string[] = (data?.result ?? []).map((z: any) => z?.name).filter(Boolean);
        if (zones.length === 0) {
          return { valid: false, message: 'The token authenticates but can see no zones — check it is scoped to a zone, not just an account.' };
        }

        const wanted = String(creds.zone ?? '').trim();
        if (wanted && !zones.includes(wanted)) {
          return {
            valid: false,
            message: `Token is valid but cannot see "${wanted}". It has access to: ${zones.slice(0, 5).join(', ')}.`,
          };
        }

        return {
          valid: true,
          message: `Can manage ${zones.length} zone${zones.length === 1 ? '' : 's'}: ${zones.slice(0, 5).join(', ')}${zones.length > 5 ? '…' : ''}.`,
        };
      }

      if (provider === 'vultr') {
        if (!creds.token) return { valid: false, message: 'Vultr Personal Access Token is required.' };
        const res = await fetch('https://api.vultr.com/v2/account', {
          headers: { Authorization: `Bearer ${creds.token}` },
        });
        if (!res.ok) return { valid: false, message: `Invalid token or unauthorized (HTTP ${res.status}).` };
        const data = await readJson(res);
        return { valid: true, message: `Authenticated as Vultr account (${data.account?.email || 'active'}).` };
      }

      if (provider === 'linode') {
        if (!creds.token) return { valid: false, message: 'Linode Personal Access Token is required.' };
        const res = await fetch('https://api.linode.com/v4/account', {
          headers: { Authorization: `Bearer ${creds.token}` },
        });
        if (!res.ok) return { valid: false, message: `Invalid token or unauthorized (HTTP ${res.status}).` };
        const data = await readJson(res);
        return { valid: true, message: `Authenticated as Linode account (${data.email || 'active'}).` };
      }

      if (provider === 'scaleway') {
        if (!creds.secretKey) return { valid: false, message: 'Scaleway Secret Key is required.' };
        const res = await fetch('https://api.scaleway.com/account/v3/projects', {
          headers: { 'X-Auth-Token': creds.secretKey },
        });
        if (!res.ok) return { valid: false, message: `Invalid secret key or unauthorized (HTTP ${res.status}).` };
        const data = await readJson(res);
        const n = Array.isArray(data?.projects) ? data.projects.length : undefined;
        return {
          valid: true,
          message: `Authenticated against Scaleway${n !== undefined ? ` (${n} project${n === 1 ? '' : 's'})` : ''}.`,
        };
      }

      if (provider === 'hostinger') {
        if (!creds.token) return { valid: false, message: 'Hostinger API token is required.' };
        const res = await fetch('https://developers.hostinger.com/api/vps/v1/data-centers', {
          headers: { Authorization: `Bearer ${creds.token}` },
        });
        if (!res.ok) return { valid: false, message: `Invalid token or unauthorized (HTTP ${res.status}).` };
        return { valid: true, message: 'Authenticated against the Hostinger API.' };
      }

      if (provider === 'contabo') {
        const { clientId, clientSecret, apiUser, apiPassword } = creds;
        if (!clientId || !clientSecret || !apiUser || !apiPassword) {
          return { valid: false, message: 'Contabo needs Client ID, Client Secret, API user and API password.' };
        }
        const res = await fetch('https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'password',
            client_id: clientId,
            client_secret: clientSecret,
            username: apiUser,
            password: apiPassword,
          }),
        });
        if (!res.ok) {
          return { valid: false, message: `Contabo rejected these credentials (HTTP ${res.status}).` };
        }
        const data = await readJson(res);
        if (!data?.access_token) return { valid: false, message: 'Contabo returned no access token.' };
        return {
          valid: true,
          message: 'Authenticated against Contabo. Note: their API exposes no pricing, so Contabo plans will not appear in the VPS catalog.',
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

  async testGoogleDriveConnection(userId: string): Promise<{ valid: boolean; message: string; details?: any }> {
    const user = await this.db.getUserById(userId);
    const decrypted = user?.credentials ? this.decryptAll(user.credentials, 'googledrive') : undefined;
    const refreshToken = (decrypted as any)?.googledrive?.refreshToken || '';
    return this.validateCredentials('googledrive', { refreshToken });
  }

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
      { key: 'cloudflare', label: 'Cloudflare DNS' },
      { key: 'vultr', label: 'Vultr' },
      { key: 'linode', label: 'Linode / Akamai' },
      { key: 'scaleway', label: 'Scaleway' },
      { key: 'hostinger', label: 'Hostinger' },
      { key: 'contabo', label: 'Contabo' },
    ];

    return providers.map(({ key, label }) => {
      const resolved = resolveCloudCredentials(key, user?.credentials ? this.decryptAll(user.credentials, key) : undefined);

      if (resolved.mode === 'mock') {
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
    const existing = (user.credentials as any)[provider] || {};
    (user.credentials as any)[provider] = { ...existing, ...encrypted };

    await this.db.saveUser(user);
  }

  async deleteCredentials(userId: string, provider: CloudProvider): Promise<void> {
    const user = await this.db.getUserById(userId);
    if (!user) throw new Error('User not found');

    if (user.credentials) {
      delete (user.credentials as any)[provider];
      await this.db.saveUser(user);
    }
  }

  async resolveCredentials(userId: string, provider: string): Promise<ResolvedCredentials> {
    const user = await this.db.getUserById(userId);
    const decrypted = user?.credentials ? this.decryptAll(user.credentials, provider) : undefined;
    return resolveCloudCredentials(provider, decrypted);
  }

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
          continue;
        }
      } else {
        decrypted[key] = value;
      }
    }

    return { [provider]: decrypted } as CloudCredentials;
  }
}
