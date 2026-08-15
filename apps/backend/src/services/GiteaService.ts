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

  /**
   * The in-cluster base URL a SANDBOX uses, which is not the one the backend uses.
   *
   * The backend reaches Gitea on a NodePort. A sandbox cannot: kube-proxy DNATs NodePort traffic to
   * the backing pod before NetworkPolicy is evaluated, so an egress rule naming the node silently
   * fails closed and the clone is refused. Measured. Service DNS routes to the pod directly, which
   * a namespace-selector egress rule can actually match.
   */
  get internalBaseUrl(): string {
    return `http://gitea-http.${NAMESPACE}.svc.cluster.local:3000`;
  }

  /** The namespace a sandbox must be allowed to reach to clone or push. */
  get namespace(): string {
    return NAMESPACE;
  }

  /**
   * Creates the Gitea account backing a platform user, if it does not exist.
   *
   * Returns the account's password so the caller can persist it encrypted — Gitea mints tokens
   * against a user's own basic auth, with no admin override, so without it the account can never
   * be used again. Callers must store it and never return it anywhere.
   */
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

  /**
   * Creates a repository OWNED BY a platform user's account, using admin rights.
   *
   * Deliberately not done with the user's own token: repository creation needs `write:user`, and
   * granting that to the token the sandbox holds would let a model create and delete repositories
   * across that account. The backend holds the power to create; the sandbox only gets to push.
   */
  /**
   * Commits a .gitignore so an install does not end up in the repository.
   *
   * ── WHY THIS IS WRITTEN AND NOT A TEMPLATE ──
   * Gitea can seed one at creation from a named template, and this instance has ZERO templates
   * installed — asked and answered: `/api/v1/gitignore/templates` returns an empty list. So the
   * file has to be written.
   *
   * ── AND WHY IT MATTERS BEYOND TIDINESS ──
   * Measured. An agent ran `npm install semver` and committed `node_modules` with it, and the
   * "repository layout" memory — built from `git ls-files` — then filled with
   * `node_modules/@hono/node-server/dist/...`. That memory is injected into EVERY prompt for that
   * project, so roughly 1,400 characters of every request became a listing of vendored files.
   *
   * Every toolchain the workspace images offer, not just the project's own: a Node project can
   * still grow a .venv, and one file at creation is cheaper than deciding later.
   */
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

  /**
   * Commits a file, unless it is already there.
   *
   * Never overwrites. Everything using this is SEEDING — a .gitignore, a template skeleton — and
   * clobbering something a project already has would destroy work to install a default.
   *
   * Returns whether it wrote, so a caller can report what it actually did rather than guessing.
   */
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

  /**
   * Seeds a repository with a template, skipping anything already present.
   *
   * Best-effort per file: a template that half-lands is still better than a repository with
   * nothing in it, and the leaf that follows can see what is missing.
   */
  async seedTemplate(
    username: string,
    name: string,
    files: { path: string; content: string }[],
  ): Promise<string[]> {
    const written: string[] = [];
    for (const f of files) {
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
    // Best-effort: a repository without one is usable, just messy. See ensureGitignore.
    await this.ensureGitignore(username, name).catch((err) =>
      console.warn(`[GiteaService] no .gitignore on ${username}/${name}: ${err.message}`));
    return { fullName: body.full_name, cloneUrl: body.clone_url };
  }

  /**
   * Mints a push token for one user, for the life of one sandbox.
   *
   * `write:repository` and nothing else. Verified against Gitea 1.27: this token cannot create a
   * repository, cannot read the account it belongs to, and gets "Repository not found" for another
   * user's repo. It is the credential that goes INTO the sandbox, so its scope is the blast radius
   * of every prompt injection the agent will ever read.
   */
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

  /** Revokes a push token. Called when a sandbox is torn down, whether or not the work succeeded. */
  async revokeUserToken(username: string, password: string, tokenName: string): Promise<void> {
    const baseUrl = await this.resolveBaseUrl();
    await fetch(`${baseUrl}/api/v1/users/${encodeURIComponent(username)}/tokens/${encodeURIComponent(tokenName)}`, {
      method: 'DELETE',
      headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` },
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

  /**
   * Merges one branch into another through a pull request.
   *
   * ── WHY A PR RATHER THAN A PUSH ──
   * The alternative is a workspace pod that clones, merges and pushes — which is what a leaf's own
   * merge does, because it already has a pod and a credential in hand. This runs after every leaf
   * of a request has finished and its pod is long gone, and spinning one up to run three git
   * commands is a poor trade. It also leaves a reviewable record of what landed and why, which a
   * force-push to main does not.
   *
   * Every outcome is returned rather than thrown. Landing is a best-effort tidy-up at the end of a
   * request: the work is already safe on its branch, and failing the workflow over a merge conflict
   * would turn "some work needs a human" into "the leaf failed".
   */
  async mergeBranch(
    owner: string,
    repo: string,
    head: string,
    base: string,
  ): Promise<'merged' | 'conflict' | 'nothing' | 'failed'> {
    const repoPath = `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

    /**
     * Look for an existing request before opening one.
     *
     * The sweep runs on EVERY leaf's terminal exit, so a request whose leaves finish together runs
     * it more than once — observed live: two sweeps raced and left duplicate pull requests for the
     * same branch. Checking first makes the whole operation idempotent, and also picks up a request
     * left open by an earlier failed landing.
     */
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
      // Gitea reports "no merge base" / an identical branch as a 409 or 422 with a message. That is
      // not a failure: it means everything on this branch is already on the base.
      if (/already exists/i.test(detail)) {
        // A PR from an earlier landing attempt. Find it and merge that instead of giving up.
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
      // Capital D — Gitea's field, not a typo.
      body: JSON.stringify({ Do: 'merge' }),
    });
    if (merged.ok) return 'merged';

    // 405 is Gitea's "this pull request cannot be merged" — a conflict needing a human. The request
    // is deliberately left open: it is the review surface for exactly this case.
    if (merged.status === 405) return 'conflict';
    return 'failed';
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
