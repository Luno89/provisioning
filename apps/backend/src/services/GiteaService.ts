/**
 * Talks to the self-hosted Gitea instance deployed by `scripts/ensure-gitea.sh` into the
 * management cluster (namespace `gitea`, release `gitea`). Authenticates as the bootstrap
 * admin (`provisioning-bot`, password generated once by that script into
 * `apps/backend/data/.gitea-admin-password`, gitignored, plaintext — same trust level as
 * Mongo/Temporal's own hardcoded dev creds), then mints and encrypt-stores a long-lived API
 * token on first use so routine calls don't need to re-authenticate with the password.
 */
import crypto from 'crypto';
import path from 'path';
import fs from 'fs/promises';
import { encryptValue, decryptValue } from '../lib/crypto.js';
import type { InfrastructureService } from './InfrastructureService.js';

const NAMESPACE = 'gitea';
const ADMIN_USERNAME = 'provisioning-bot';
const DATA_DIR = path.join(process.cwd(), 'data');
const PASSWORD_FILE = path.join(DATA_DIR, '.gitea-admin-password');
const TOKEN_FILE = path.join(DATA_DIR, '.gitea-admin-token');

export class GiteaService {
  private baseUrlCache: string | null = null;
  private tokenCache: string | null = null;

  constructor(
    private readonly infra: InfrastructureService,
    private readonly masterKey: string,
    private readonly kubeconfigPath: string,
  ) {}

  /**
   * Resolves ONE address for Gitea's NodePort service that works for every audience that needs
   * it: this backend process (on the host), pods doing a git clone or registry push (Kaniko),
   * and — critically — the *node's own containerd* pulling images for regular pods, which does
   * NOT go through CoreDNS at all (kubelet/containerd resolves image references via the node's
   * OS-level resolver, not the cluster's in-cluster DNS) — confirmed live: an in-cluster Service
   * DNS name (`gitea-http.gitea.svc.cluster.local`) works fine for Kaniko's own push (pod-side
   * resolution, uses CoreDNS) but every regular pod's image *pull* failed with
   * "lookup ...: Try again" since kubelet never resolves that name. The node's real IP sidesteps
   * DNS resolution entirely and satisfies every one of those audiences at once.
   *
   * On native k3s (Linux, this platform's actual dev target) that's the node's own reported
   * InternalIP; on real k3d (macOS) it's the k3d server container's docker-network IP, mirroring
   * AppExposureService.buildUpstreamTarget()'s existing platform branch for NodePort services in
   * this same management cluster.
   */
  private async resolveBaseUrl(): Promise<string> {
    if (this.baseUrlCache) return this.baseUrlCache;

    const svcJson = await this.infra.runKubectl(
      ['get', 'svc', 'gitea-http', '-n', NAMESPACE, '-o', 'json'],
      this.kubeconfigPath,
    );
    const svc = JSON.parse(svcJson);
    const nodePort = svc.spec?.ports?.find((p: any) => p.name === 'http')?.nodePort ?? svc.spec?.ports?.[0]?.nodePort;
    if (!nodePort) {
      throw new Error('Gitea service has no nodePort assigned — did ensure-gitea.sh set the NodePort override?');
    }

    let host: string;
    if (process.platform === 'linux') {
      // A dual-stack node reports multiple InternalIP entries (IPv4 + IPv6) — jsonpath's filter
      // returns all of them space-joined, not just one. Confirmed live. IPv4 is always first.
      const raw = await this.infra.runKubectl(
        ['get', 'nodes', '-o', 'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}'],
        this.kubeconfigPath,
      );
      const parsed = raw.trim().split(/\s+/)[0];
      if (!parsed) throw new Error('Could not resolve the management cluster node\'s InternalIP');
      host = parsed;
    } else {
      host = await this.infra.getK3dServerIp('provisioning-lunorica');
    }

    this.baseUrlCache = `http://${host}:${nodePort}`;
    return this.baseUrlCache;
  }

  private async readAdminPassword(): Promise<string> {
    const raw = await fs.readFile(PASSWORD_FILE, 'utf8');
    return raw.trim();
  }

  /**
   * Mints an API token on first use and encrypt-stores it (AES-256-GCM, same
   * `crypto.ts` helpers CredentialService already uses for user-supplied cloud
   * credentials) — subsequent calls just decrypt the cached file instead of re-authenticating.
   */
  private async getToken(): Promise<string> {
    if (this.tokenCache) return this.tokenCache;

    try {
      const encrypted = await fs.readFile(TOKEN_FILE, 'utf8');
      this.tokenCache = decryptValue(encrypted.trim(), this.masterKey);
      // Verify liveness — a wiped Gitea data volume (e.g. after `npm run clean-dev`) leaves a
      // stale-but-still-decryptable token on disk that no longer authenticates.
      const baseUrl = await this.resolveBaseUrl();
      const res = await fetch(`${baseUrl}/api/v1/user`, {
        headers: { Authorization: `token ${this.tokenCache}` },
      });
      if (res.ok) return this.tokenCache;
    } catch {
      // File missing, undecryptable, or stale — fall through to mint a fresh one.
    }

    const baseUrl = await this.resolveBaseUrl();
    const password = await this.readAdminPassword();
    const tokenName = `backend-${crypto.randomBytes(4).toString('hex')}`;
    const res = await fetch(`${baseUrl}/api/v1/users/${ADMIN_USERNAME}/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${ADMIN_USERNAME}:${password}`).toString('base64')}`,
      },
      body: JSON.stringify({ name: tokenName, scopes: ['write:repository', 'write:package', 'write:admin', 'write:user'] }),
    });
    if (!res.ok) {
      throw new Error(`Failed to mint Gitea API token: HTTP ${res.status} ${await res.text()}`);
    }
    const body = await res.json() as { sha1: string };
    this.tokenCache = body.sha1;

    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(TOKEN_FILE, encryptValue(this.tokenCache, this.masterKey), { mode: 0o600 });

    return this.tokenCache;
  }

  private async apiFetch(pathSuffix: string, init: RequestInit = {}): Promise<Response> {
    const baseUrl = await this.resolveBaseUrl();
    const token = await this.getToken();
    return fetch(`${baseUrl}${pathSuffix}`, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `token ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  }

  async createRepo(name: string, opts: { private?: boolean; description?: string } = {}): Promise<{ owner: string; name: string; cloneUrl: string }> {
    const res = await this.apiFetch(`/api/v1/user/repos`, {
      method: 'POST',
      body: JSON.stringify({ name, private: opts.private ?? true, description: opts.description, auto_init: true }),
    });
    if (!res.ok) {
      throw new Error(`Failed to create Gitea repo "${name}": HTTP ${res.status} ${await res.text()}`);
    }
    const body = await res.json() as { owner: { login: string }; name: string; clone_url: string };
    return { owner: body.owner.login, name: body.name, cloneUrl: body.clone_url };
  }

  async getRepo(owner: string, name: string): Promise<any> {
    const res = await this.apiFetch(`/api/v1/repos/${owner}/${name}`);
    if (!res.ok) {
      throw new Error(`Gitea repo "${owner}/${name}" not found: HTTP ${res.status}`);
    }
    return res.json();
  }

  async createWebhook(owner: string, name: string, targetUrl: string, secret: string): Promise<void> {
    const res = await this.apiFetch(`/api/v1/repos/${owner}/${name}/hooks`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'gitea',
        active: true,
        events: ['push'],
        config: { url: targetUrl, content_type: 'json', secret },
      }),
    });
    if (!res.ok) {
      throw new Error(`Failed to create webhook on "${owner}/${name}": HTTP ${res.status} ${await res.text()}`);
    }
  }

  /**
   * Gitea has no per-repo scoped-token API (unlike GitHub Apps / GitLab project tokens) — its
   * tokens are user+permission scoped only. This mints a fresh, narrowly-scoped token tied to
   * the same bootstrap admin user via the same endpoint the long-lived admin token uses, so
   * each build Job gets its own short-lived, individually revocable credential even though it
   * isn't literally restricted to one repo. Scoped to exactly what a build Job needs: cloning
   * the source (read:repository) and pushing the built image (write:package) — nothing else.
   */
  async createDeployToken(): Promise<{ name: string; token: string }> {
    const baseUrl = await this.resolveBaseUrl();
    const password = await this.readAdminPassword();
    const tokenName = `build-${crypto.randomBytes(4).toString('hex')}`;
    const res = await fetch(`${baseUrl}/api/v1/users/${ADMIN_USERNAME}/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${ADMIN_USERNAME}:${password}`).toString('base64')}`,
      },
      body: JSON.stringify({ name: tokenName, scopes: ['read:repository', 'write:package'] }),
    });
    if (!res.ok) {
      throw new Error(`Failed to create deploy token: HTTP ${res.status} ${await res.text()}`);
    }
    const body = await res.json() as { sha1: string };
    return { name: tokenName, token: body.sha1 };
  }

  /** Revokes a token minted by createDeployToken — call after the build Job that used it finishes. */
  async revokeToken(tokenName: string): Promise<void> {
    const baseUrl = await this.resolveBaseUrl();
    const password = await this.readAdminPassword();
    await fetch(`${baseUrl}/api/v1/users/${ADMIN_USERNAME}/tokens/${tokenName}`, {
      method: 'DELETE',
      headers: { Authorization: `Basic ${Buffer.from(`${ADMIN_USERNAME}:${password}`).toString('base64')}` },
    });
  }

  /** For build-Job manifests that need Gitea's internal registry host + credential shape directly. */
  get adminUsername(): string {
    return ADMIN_USERNAME;
  }

  /**
   * Used only for the dashboard-proxy auto-login flow (index.ts's /api/clusters/:id/proxy/gitea
   * route) — never returned to the browser or logged. The password never leaves the backend
   * process; only the resulting session cookie from Gitea's own /user/login gets relayed.
   */
  async getAdminCredentials(): Promise<{ username: string; password: string }> {
    return { username: ADMIN_USERNAME, password: await this.readAdminPassword() };
  }

  async getRawFile(owner: string, name: string, filePath: string, ref?: string): Promise<string | null> {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const res = await this.apiFetch(`/api/v1/repos/${owner}/${name}/raw/${filePath}${query}`);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Failed to fetch "${filePath}" from "${owner}/${name}": HTTP ${res.status}`);
    }
    return res.text();
  }

  /**
   * Gitea signs push-webhook payloads with `X-Gitea-Signature` (HMAC-SHA256 of the raw request
   * body, hex-encoded) — verify with a constant-time comparison before trusting the payload.
   */
  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
    if (!signatureHeader) return false;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(signatureHeader, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async getRegistryHost(): Promise<string> {
    // Deliberately the *same* node-IP:nodePort address resolveBaseUrl() uses for the HTTP API —
    // see that method's comment for why an in-cluster DNS name doesn't work here even though it
    // seems like the "proper" in-cluster address (kubelet's own image-pull DNS resolution never
    // goes through CoreDNS, so pod images referencing it can never actually be pulled).
    const baseUrl = await this.resolveBaseUrl();
    return baseUrl.replace(/^https?:\/\//, '');
  }
}
