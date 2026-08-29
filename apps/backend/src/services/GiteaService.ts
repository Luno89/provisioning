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

  private async getToken(): Promise<string> {
    if (this.tokenCache) return this.tokenCache;

    try {
      const encrypted = await fs.readFile(TOKEN_FILE, 'utf8');
      this.tokenCache = decryptValue(encrypted.trim(), this.masterKey);
      const baseUrl = await this.resolveBaseUrl();
      const res = await fetch(`${baseUrl}/api/v1/user`, {
        headers: { Authorization: `token ${this.tokenCache}` },
      });
      if (res.ok) return this.tokenCache;
    } catch {
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

    await this.ensureClusterSecret(this.tokenCache).catch(() => undefined);

    return this.tokenCache;
  }

  async ensureClusterSecret(explicitToken?: string): Promise<void> {
    try {
      const token = explicitToken ?? (await this.getToken());
      const manifest = {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: 'gitea-credentials',
          namespace: NAMESPACE,
        },
        type: 'Opaque',
        stringData: {
          token,
          host: 'gitea-http.gitea.svc.cluster.local',
          port: '3000',
          protocol: 'http',
        },
      };
      const tmpPath = path.join('/tmp', `gitea-secret-${crypto.randomBytes(4).toString('hex')}.json`);
      await fs.writeFile(tmpPath, JSON.stringify(manifest), 'utf8');
      try {
        await this.infra.runKubectl(['apply', '-f', tmpPath], this.kubeconfigPath);
      } finally {
        await fs.unlink(tmpPath).catch(() => undefined);
      }
    } catch (err: any) {
      console.warn(`[GiteaService] could not sync gitea-credentials secret: ${err.message}`);
    }
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

  async revokeToken(tokenName: string): Promise<void> {
    const baseUrl = await this.resolveBaseUrl();
    const password = await this.readAdminPassword();
    await fetch(`${baseUrl}/api/v1/users/${ADMIN_USERNAME}/tokens/${tokenName}`, {
      method: 'DELETE',
      headers: { Authorization: `Basic ${Buffer.from(`${ADMIN_USERNAME}:${password}`).toString('base64')}` },
    });
  }

  get internalBaseUrl(): string {
    return `http://gitea-http.${NAMESPACE}.svc.cluster.local:3000`;
  }

  get namespace(): string {
    return NAMESPACE;
  }

  async createUserAccount(username: string, email: string): Promise<{ password: string }> {
    const baseUrl = await this.resolveBaseUrl();
    const adminPassword = await this.readAdminPassword();
    const password = crypto.randomBytes(24).toString('base64url');

    const res = await fetch(`${baseUrl}/api/v1/admin/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${ADMIN_USERNAME}:${adminPassword}`).toString('base64')}`,
      },
      body: JSON.stringify({ username, email, password, must_change_password: false }),
    });
    if (!res.ok) throw new Error(`Failed to create Gitea account ${username}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return { password };
  }

  async ensureGitignore(username: string, name: string): Promise<void> {
    const baseUrl = await this.resolveBaseUrl();
    const adminPassword = await this.readAdminPassword();
    const auth = `Basic ${Buffer.from(`${ADMIN_USERNAME}:${adminPassword}`).toString('base64')}`;

    const content = [
      '# Dependencies — an install must never become a commit.',
      'node_modules/',
      'vendor/',
      '.venv/',
      'venv/',
      '__pycache__/',
      '*.pyc',
      '',
      '# Build output',
      'dist/',
      'build/',
      '',
      '# Local noise',
      '.env',
      '.DS_Store',
      '*.log',
      '',
    ].join('\n');

    await this.ensureFile(username, name, '.gitignore', content, 'Add .gitignore');
  }

  async ensureFile(
    username: string,
    name: string,
    path: string,
    content: string,
    message: string,
  ): Promise<boolean> {
    const baseUrl = await this.resolveBaseUrl();
    const adminPassword = await this.readAdminPassword();
    const auth = `Basic ${Buffer.from(`${ADMIN_USERNAME}:${adminPassword}`).toString('base64')}`;
    const url = `${baseUrl}/api/v1/repos/${encodeURIComponent(username)}/${encodeURIComponent(name)}/contents/${path}`;

    const existing = await fetch(url, { headers: { Authorization: auth } });
    if (existing.ok) return false;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({ content: Buffer.from(content).toString('base64'), message }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
    return true;
  }

  async inspectBranch(
    username: string,
    name: string,
    ref: string,
    paths: string[],
  ): Promise<{ exists: boolean; found: string[]; missing: string[]; commitsAhead?: number }> {
    const baseUrl = await this.resolveBaseUrl();
    const adminPassword = await this.readAdminPassword();
    const auth = `Basic ${Buffer.from(`${ADMIN_USERNAME}:${adminPassword}`).toString('base64')}`;
    const repo = `${baseUrl}/api/v1/repos/${encodeURIComponent(username)}/${encodeURIComponent(name)}`;

    const branch = await fetch(`${repo}/branches/${encodeURIComponent(ref)}`, { headers: { Authorization: auth } })
      .catch(() => undefined);
    if (!branch?.ok) return { exists: false, found: [], missing: paths };

    const found: string[] = [];
    const missing: string[] = [];
    for (const path of paths) {
      const res = await fetch(
        `${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
        { headers: { Authorization: auth } },
      ).catch(() => undefined);
      if (!res?.ok) { missing.push(path); continue; }
      const body = await res.json().catch(() => ({})) as { size?: number };
      if (typeof body.size === 'number' && body.size > 0) found.push(path);
      else missing.push(path);
    }

    return { exists: true, found, missing };
  }

  async seedTemplate(
    username: string,
    name: string,
    files: { path: string; content: string }[],
  ): Promise<string[]> {
    if (!files.length) return [];

    const baseUrl = await this.resolveBaseUrl();
    const adminPassword = await this.readAdminPassword();
    const auth = `Basic ${Buffer.from(`${ADMIN_USERNAME}:${adminPassword}`).toString('base64')}`;
    const repo = `${baseUrl}/api/v1/repos/${encodeURIComponent(username)}/${encodeURIComponent(name)}`;

    const missing: { path: string; content: string }[] = [];
    for (const f of files) {
      const existing = await fetch(`${repo}/contents/${f.path}`, { headers: { Authorization: auth } })
        .catch(() => undefined);
      if (!existing?.ok) missing.push(f);
    }
    if (!missing.length) return [];

    const res = await fetch(`${repo}/contents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({
        message: `Scaffold the project\n\n${missing.map((f) => `- ${f.path}`).join('\n')}`,
        files: missing.map((f) => ({
          operation: 'create',
          path: f.path,
          content: Buffer.from(f.content).toString('base64'),
        })),
      }),
    }).catch(() => undefined);

    if (res?.ok) return missing.map((f) => f.path);

    const written: string[] = [];
    for (const f of missing) {
      const did = await this.ensureFile(username, name, f.path, f.content, `Scaffold ${f.path}`)
        .catch(() => false);
      if (did) written.push(f.path);
    }
    return written;
  }

  async createRepoForUser(username: string, name: string, opts: { private?: boolean; description?: string } = {}) {
    const baseUrl = await this.resolveBaseUrl();
    const adminPassword = await this.readAdminPassword();
    const res = await fetch(`${baseUrl}/api/v1/admin/users/${encodeURIComponent(username)}/repos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${ADMIN_USERNAME}:${adminPassword}`).toString('base64')}`,
      },
      body: JSON.stringify({ name, private: opts.private ?? true, description: opts.description, auto_init: true }),
    });
    if (!res.ok) throw new Error(`Failed to create repo ${username}/${name}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = await res.json() as { clone_url: string; full_name: string };
    await this.ensureGitignore(username, name).catch((err) =>
      console.warn(`[GiteaService] no .gitignore on ${username}/${name}: ${err.message}`));
    return { fullName: body.full_name, cloneUrl: body.clone_url };
  }

  async createPushToken(username: string, password: string): Promise<{ name: string; token: string }> {
    const baseUrl = await this.resolveBaseUrl();
    const tokenName = `koala-run-${crypto.randomBytes(4).toString('hex')}`;
    const res = await fetch(`${baseUrl}/api/v1/users/${encodeURIComponent(username)}/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
      },
      body: JSON.stringify({ name: tokenName, scopes: ['write:repository'] }),
    });
    if (!res.ok) throw new Error(`Failed to mint push token for ${username}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = await res.json() as { sha1: string };
    return { name: tokenName, token: body.sha1 };
  }

  async revokeUserToken(username: string, password: string, tokenName: string): Promise<void> {
    const baseUrl = await this.resolveBaseUrl();
    await fetch(`${baseUrl}/api/v1/users/${encodeURIComponent(username)}/tokens/${encodeURIComponent(tokenName)}`, {
      method: 'DELETE',
      headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` },
    });
  }

  get adminUsername(): string {
    return ADMIN_USERNAME;
  }

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

  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
    if (!signatureHeader) return false;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(signatureHeader, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async mergeBranch(
    owner: string,
    repo: string,
    head: string,
    base: string,
  ): Promise<'merged' | 'conflict' | 'nothing' | 'failed'> {
    const repoPath = `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

    const existing = await this.apiFetch(`${repoPath}/pulls?state=open&limit=50`);
    if (existing.ok) {
      const open = (await existing.json().catch(() => [])) as any[];
      const already = open.find((pr) => pr?.head?.ref === head && pr?.base?.ref === base)?.number;
      if (typeof already === 'number') return this.mergePull(repoPath, already);
    }

    const created = await this.apiFetch(`${repoPath}/pulls`, {
      method: 'POST',
      body: JSON.stringify({ head, base, title: `Land ${head}` }),
    });

    let index: number | undefined;
    if (created.ok) {
      index = ((await created.json().catch(() => ({}))) as { number?: number }).number;
    } else {
      const detail = await created.text().catch(() => '');
      if (/already exists/i.test(detail)) {
        const open = await this.apiFetch(`${repoPath}/pulls?state=open&limit=50`);
        const list = open.ok ? (await open.json().catch(() => [])) as any[] : [];
        index = list.find((pr) => pr?.head?.ref === head && pr?.base?.ref === base)?.number;
      } else if (/no merge base|identical|nothing to compare|not different/i.test(detail)) {
        return 'nothing';
      }
      if (index === undefined) return 'failed';
    }
    if (index === undefined) return 'failed';
    return this.mergePull(repoPath, index);
  }

  private async mergePull(repoPath: string, index: number): Promise<'merged' | 'conflict' | 'failed'> {
    const merged = await this.apiFetch(`${repoPath}/pulls/${index}/merge`, {
      method: 'POST',
      body: JSON.stringify({ Do: 'merge' }),
    });
    if (merged.ok) return 'merged';

    if (merged.status === 405) return 'conflict';
    return 'failed';
  }

  async getRegistryHost(): Promise<string> {
    const baseUrl = await this.resolveBaseUrl();
    return baseUrl.replace(/^https?:\/\//, '');
  }
}
