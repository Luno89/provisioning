import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import { encryptValue, decryptValue } from '../lib/crypto.js';

const execFileAsync = promisify(execFile);

const CONTAINER_NAME = 'provisioning-headscale';
const DATA_DIR = path.join(process.cwd(), 'data');
const API_KEY_FILE = path.join(DATA_DIR, '.headscale-api-key');

export interface MeshDevice {
  id: string;
  name: string;
  ipAddresses: string[];
  online: boolean;
  lastSeen?: string;
}

export class HeadscaleService {
  private apiKeyCache: string | null = null;
  private userIdCache = new Map<string, string>();

  constructor(
    private readonly masterKey: string,
    private readonly baseUrl: string = 'http://localhost:8080',
  ) {}

  private async getApiKey(): Promise<string> {
    if (this.apiKeyCache) return this.apiKeyCache;

    try {
      const encrypted = await fs.readFile(API_KEY_FILE, 'utf8');
      const candidate = decryptValue(encrypted.trim(), this.masterKey);
      const res = await fetch(`${this.baseUrl}/api/v1/apikey`, {
        headers: { Authorization: `Bearer ${candidate}` },
      });
      if (res.ok) {
        this.apiKeyCache = candidate;
        return candidate;
      }
    } catch { /* ignored */ }

    const { stdout } = await execFileAsync('docker', [
      'exec', CONTAINER_NAME, 'headscale', 'apikeys', 'create', '--expiration', '87600h',
    ]);
    const key = stdout.trim();
    if (!key) throw new Error('"headscale apikeys create" returned no key — is the container running?');
    this.apiKeyCache = key;

    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(API_KEY_FILE, encryptValue(key, this.masterKey), { mode: 0o600 });

    return key;
  }

  private async apiFetch(pathSuffix: string, init: RequestInit = {}): Promise<Response> {
    const apiKey = await this.getApiKey();
    return fetch(`${this.baseUrl}${pathSuffix}`, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${apiKey}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  }

  private async ensureHeadscaleUser(platformUserId: string): Promise<string> {
    const cached = this.userIdCache.get(platformUserId);
    if (cached) return cached;

    const name = `platform-${platformUserId}`;
    const listRes = await this.apiFetch(`/api/v1/user?name=${encodeURIComponent(name)}`);
    if (!listRes.ok) throw new Error(`Failed to list Headscale users: HTTP ${listRes.status}`);
    const listBody = (await listRes.json()) as { users?: Array<{ id: string; name: string }> };
    const existing = listBody.users?.find((u) => u.name === name);
    if (existing) {
      this.userIdCache.set(platformUserId, existing.id);
      return existing.id;
    }

    const createRes = await this.apiFetch('/api/v1/user', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    if (!createRes.ok) {
      throw new Error(`Failed to create Headscale user "${name}": HTTP ${createRes.status} ${await createRes.text()}`);
    }
    const createBody = (await createRes.json()) as { user: { id: string } };
    this.userIdCache.set(platformUserId, createBody.user.id);
    return createBody.user.id;
  }

  async createPreAuthKey(
    platformUserId: string,
    opts: { reusable?: boolean; expirySeconds?: number } = {},
  ): Promise<{ key: string; expiration: string }> {
    const headscaleUserId = await this.ensureHeadscaleUser(platformUserId);
    const expiration = new Date(Date.now() + (opts.expirySeconds ?? 3600) * 1000).toISOString();
    const res = await this.apiFetch('/api/v1/preauthkey', {
      method: 'POST',
      body: JSON.stringify({
        user: headscaleUserId,
        reusable: opts.reusable ?? false,
        ephemeral: false,
        expiration,
      }),
    });
    if (!res.ok) {
      throw new Error(`Failed to create Headscale pre-auth key: HTTP ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { preAuthKey: { key: string; expiration: string } };
    return { key: body.preAuthKey.key, expiration: body.preAuthKey.expiration };
  }

  async listUserDevices(platformUserId: string): Promise<MeshDevice[]> {
    await this.ensureHeadscaleUser(platformUserId);
    const name = `platform-${platformUserId}`;
    const res = await this.apiFetch(`/api/v1/node?user=${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`Failed to list Headscale nodes: HTTP ${res.status}`);
    const body = (await res.json()) as {
      nodes?: Array<{ id: string; name: string; ipAddresses?: string[]; online?: boolean; lastSeen?: string }>;
    };
    return (body.nodes ?? []).map((n) => ({
      id: n.id,
      name: n.name,
      ipAddresses: n.ipAddresses ?? [],
      online: n.online ?? false,
      ...(n.lastSeen !== undefined ? { lastSeen: n.lastSeen } : {}),
    }));
  }

  async revokeDevice(nodeId: string): Promise<void> {
    const res = await this.apiFetch(`/api/v1/node/${nodeId}`, { method: 'DELETE' });
    if (!res.ok) {
      throw new Error(`Failed to revoke Headscale node ${nodeId}: HTTP ${res.status} ${await res.text()}`);
    }
  }

  async resolveDeviceMeshIp(nodeId: string): Promise<string | undefined> {
    const res = await this.apiFetch(`/api/v1/node/${nodeId}`);
    if (!res.ok) throw new Error(`Failed to get Headscale node ${nodeId}: HTTP ${res.status}`);
    const body = (await res.json()) as { node?: { ipAddresses?: string[] } };
    return body.node?.ipAddresses?.find((ip) => ip.startsWith('100.'));
  }
}
