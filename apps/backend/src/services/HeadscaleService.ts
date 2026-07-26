/**
 * Talks to the self-hosted Headscale instance (docker-compose.headscale.yml, container
 * `provisioning-headscale`) — the coordination server for the root-node → remote-cluster-target
 * mesh (VPS instances, GPU workstations). Every endpoint/shape here is verified against
 * Headscale's real v0.29.2 OpenAPI spec (gen/openapiv2/headscale/v1/*.swagger.json in
 * juanfont/headscale), not assumed.
 */
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
  private userIdCache = new Map<string, string>(); // platformUserId -> headscale numeric user id

  constructor(
    private readonly masterKey: string,
    private readonly baseUrl: string = 'http://localhost:8080',
  ) {}

  /**
   * Headscale's REST API is itself Bearer-token gated, and there's no unauthenticated bootstrap
   * endpoint to mint the very first key — confirmed against the real docs, the only way is
   * `headscale apikeys create` run inside the container. Mirrors GiteaService's token-file
   * caching pattern: mint once, encrypt-store on disk, verify liveness before reuse (a wiped
   * Headscale data volume, e.g. after `npm run clean-dev`, leaves a stale-but-decryptable key on
   * disk that no longer authenticates).
   */
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
    } catch {
      // File missing, undecryptable, or stale — fall through to mint a fresh one.
    }

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

  /**
   * Headscale "users" are namespaces nodes register under, not this platform's own accounts —
   * one Headscale user per platform user, named by the platform user's id (stable, never
   * reused, unlike email which can change), created lazily on first mesh interaction.
   */
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

  /**
   * Mints a single-use pre-auth key scoped to this platform user's Headscale namespace — the
   * core of the onboarding flow used by both Phase 2 (SSH k3s bootstrap onto a GPU workstation)
   * and Phase 3 (a freshly-created VPS): mint key here, SSH to the target, install the tailscale
   * client, `tailscale up --login-server=<headscale-url> --authkey=<key>`, and the target is
   * reachable at a stable mesh IP with no port-forwarding.
   */
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

  /**
   * Lists every mesh device (node) registered under this platform user's Headscale namespace.
   * Ensures the namespace exists first — confirmed live that Headscale's `ListNodes?user=`
   * returns HTTP 500 "user not found" (not an empty list) for a name with no Headscale user yet,
   * which is the normal case for any platform user who hasn't minted a pre-auth key before.
   */
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

  /** Revokes (deletes) a mesh device — e.g. when a user removes a remote cluster target. */
  async revokeDevice(nodeId: string): Promise<void> {
    const res = await this.apiFetch(`/api/v1/node/${nodeId}`, { method: 'DELETE' });
    if (!res.ok) {
      throw new Error(`Failed to revoke Headscale node ${nodeId}: HTTP ${res.status} ${await res.text()}`);
    }
  }

  /**
   * Resolves a joined device's stable mesh IPv4 address (the 100.64.0.0/10 CGNAT range this
   * instance's prefixes.v4 allocates from, see headscale/config/config.yaml) — what Phase 2's
   * remote-host provisioning rewrites a remote cluster's kubeconfig server address to.
   */
  async resolveDeviceMeshIp(nodeId: string): Promise<string | undefined> {
    const res = await this.apiFetch(`/api/v1/node/${nodeId}`);
    if (!res.ok) throw new Error(`Failed to get Headscale node ${nodeId}: HTTP ${res.status}`);
    const body = (await res.json()) as { node?: { ipAddresses?: string[] } };
    return body.node?.ipAddresses?.find((ip) => ip.startsWith('100.'));
  }
}
