import {
  type Database, type CloudCredentials, type CloudProvider, encryptValue, decryptValue, maskSecret,
  type SecretKey,
} from '../../platform/index.js';
import { COMBINED_CLAIMS, resolveCloudCredentials, usesOperatorCredentials, type ResolvedCredentials } from '../lib/credential-resolver.js';
import { clusterAvailability } from '../lib/cluster-topology.js';
import { OVH_SUBSIDIARIES } from '../lib/vps-catalog/adapters.js';
import { credentialsFromEnv, dnsProviderNamed, DNS_PROVIDERS, isDnsProviderName, plainFieldsOf, secretFieldsOf } from '../lib/dns-providers.js';
import { DnsProviders } from './dns/DnsProviders.js';
import { OvhClient, type FetchLike } from './OvhClient.js';
import { at, isJsonRecord, listAt, textAt } from '../lib/json-reading.js';
import type { ClaimSettings } from '../../platform/index.js';

async function readJson(res: Response): Promise<unknown> {
  return res.json();
}

const SENSITIVE_FIELDS: Record<string, string[]> = {
  aws: ['accessKeyId', 'secretAccessKey'],
  gcp: ['serviceAccountJson'],
  azure: ['clientId', 'clientSecret'],
  do: ['token'],
  hetzner: ['token'],
  vultr: ['token'],
  linode: ['token'],
  scaleway: ['secretKey'],
  hostinger: ['token'],
  contabo: ['clientId', 'clientSecret', 'apiPassword'],
  ovh: ['applicationKey', 'applicationSecret', 'consumerKey'],
  huggingface: ['hfToken'],
  artificialanalysis: ['apiKey'],
  github: ['token'],
  googledrive: ['refreshToken', 'backupPassword'],
  ...Object.fromEntries(DNS_PROVIDERS.map((provider) => [provider.name, secretFieldsOf(provider)])),
};

const PLAINTEXT_FIELDS: Record<string, string[]> = {
  aws: ['region'],
  gcp: ['projectId'],
  azure: ['subscriptionId', 'tenantId'],
  do: [],
  hetzner: [],
  vultr: [],
  linode: [],
  scaleway: ['accessKey', 'projectId'],
  hostinger: [],
  contabo: ['apiUser'],
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
  clusters?: 'available' | 'mock-only' | 'not-yet';
}

export class CredentialService {
  constructor(
    private readonly db: Database,
    private readonly masterKey: SecretKey,
    private readonly claims: ClaimSettings = COMBINED_CLAIMS,
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
          const parsed: unknown = JSON.parse(creds.serviceAccountJson);
          const projectId = textAt(parsed, 'project_id');
          if (textAt(parsed, 'type') !== 'service_account' || !projectId) {
            return { valid: false, message: 'Invalid GCP Service Account JSON structure.' };
          }
          return { valid: true, message: `Validated GCP Service Account for project "${projectId}"` };
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
        return { valid: true, message: `Authenticated as DigitalOcean account (${textAt(data, 'account', 'email') || 'active'})` };
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
        const total = at(data, 'meta', 'pagination', 'total_entries');
        return {
          valid: true,
          message: `Authenticated against Hetzner Cloud project${
            typeof total === 'number' ? ` (${total} existing server${total === 1 ? '' : 's'})` : ''
          }.`,
        };
      }

      if (provider === 'vultr') {
        if (!creds.token) return { valid: false, message: 'Vultr Personal Access Token is required.' };
        const res = await fetch('https://api.vultr.com/v2/account', {
          headers: { Authorization: `Bearer ${creds.token}` },
        });
        if (!res.ok) return { valid: false, message: `Invalid token or unauthorized (HTTP ${res.status}).` };
        const data = await readJson(res);
        return { valid: true, message: `Authenticated as Vultr account (${textAt(data, 'account', 'email') || 'active'}).` };
      }

      if (provider === 'linode') {
        if (!creds.token) return { valid: false, message: 'Linode Personal Access Token is required.' };
        const res = await fetch('https://api.linode.com/v4/account', {
          headers: { Authorization: `Bearer ${creds.token}` },
        });
        if (!res.ok) return { valid: false, message: `Invalid token or unauthorized (HTTP ${res.status}).` };
        const data = await readJson(res);
        return { valid: true, message: `Authenticated as Linode account (${textAt(data, 'email') || 'active'}).` };
      }

      if (provider === 'scaleway') {
        if (!creds.secretKey) return { valid: false, message: 'Scaleway Secret Key is required.' };
        const res = await fetch('https://api.scaleway.com/account/v3/projects', {
          headers: { 'X-Auth-Token': creds.secretKey },
        });
        if (!res.ok) return { valid: false, message: `Invalid secret key or unauthorized (HTTP ${res.status}).` };
        const data = await readJson(res);
        const projects = at(data, 'projects');
        const n = Array.isArray(projects) ? listAt(data, 'projects').length : undefined;
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
        if (!textAt(data, 'access_token')) return { valid: false, message: 'Contabo returned no access token.' };
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
      { key: 'aws', label: 'Amazon Web Services' },
      { key: 'gcp', label: 'Google Cloud Platform' },
      { key: 'azure', label: 'Microsoft Azure' },
      { key: 'do', label: 'DigitalOcean' },
      { key: 'hetzner', label: 'Hetzner Cloud' },
      { key: 'vultr', label: 'Vultr' },
      { key: 'linode', label: 'Linode / Akamai' },
      { key: 'scaleway', label: 'Scaleway' },
      { key: 'hostinger', label: 'Hostinger' },
      { key: 'contabo', label: 'Contabo' },
      { key: 'ovh', label: 'OVHcloud' },
      ...DNS_PROVIDERS.map((provider) => ({ key: provider.name as CloudProvider, label: provider.label })),
    ];

    return providers.map(({ key, label }) => {
      const resolved = resolveCloudCredentials(key, user?.credentials ? this.decryptAll(user.credentials, key) : undefined, usesOperatorCredentials(user, this.claims));
      const clusters = clusterAvailability(key, process.env);
      const unkeyed = clusters ? { clusters } : {};

      if (resolved.mode === 'mock') {
        return { provider: key, label, configured: false, ...unkeyed };
      }

      const summary: Record<string, string> = {};
      for (const [k, v] of Object.entries(resolved.env)) {
        summary[k] = maskSecret(v);
      }

      return { provider: key, label, configured: true, source: resolved.mode, summary, ...unkeyed };
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
    Object.assign(user.credentials, { [provider]: { ...(isJsonRecord(existing) ? existing : {}), ...encrypted } });

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
    return resolved.mode === 'mock' ? undefined : credentialsFromEnv(dnsProviderNamed(provider), resolved.env);
  }

  async resolveCredentials(userId: string, provider: string): Promise<ResolvedCredentials> {
    const user = await this.db.accounts.getUserById(userId);
    const decrypted = user?.credentials ? this.decryptAll(user.credentials, provider) : undefined;
    return resolveCloudCredentials(provider, decrypted, usesOperatorCredentials(user, this.claims));
  }

  private decryptAll(credentials: CloudCredentials, provider: string): CloudCredentials {
    const providerCreds = at(credentials, provider);
    if (!isJsonRecord(providerCreds)) return {};

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
