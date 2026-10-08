import type { SecretKey } from '../lib/crypto.js';
import path from 'path';
import fs from 'fs/promises';
import axios from 'axios';
import type { InfrastructureService } from './InfrastructureService.js';
import type { ClusterProxyService } from './ClusterProxyService.js';

const NAMESPACE = 'infisical';
const DATA_DIR = path.join(process.cwd(), 'data');
const AUTH_SECRET_FILE = path.join(DATA_DIR, '.infisical-auth-secret');
const ADMIN_PASSWORD_FILE = path.join(DATA_DIR, '.infisical-admin-password');

export interface InfisicalSecretRecord {
  key: string;
  secretReference: string;
  version?: number | undefined;
  comment?: string | undefined;
}

export class InfisicalService {
  private baseUrlCache: string | null = null;
  private tokenCache: string | null = null;
  private orgId: string | null = null;
  private readonly workspaceCache = new Map<string, string>();

  constructor(
    private readonly infra: Pick<InfrastructureService, 'runKubectl'>,
    private readonly masterKey: SecretKey,
    private readonly kubeconfigPath: string,
    private readonly customBaseUrl?: string,
    private readonly clusterProxy?: Pick<ClusterProxyService, 'ensurePortForward'>,
  ) {}

  async resolveBaseUrl(): Promise<string> {
    if (this.customBaseUrl) return this.customBaseUrl;
    if (this.baseUrlCache) return this.baseUrlCache;

    // The Helm-deployed Infisical service is ClusterIP-only (no NodePort) — confirmed live, the
    // NodePort lookup below always fell through to a stale fallback address, so route through the
    // same kubectl port-forward mechanism ClusterProxyService already uses successfully elsewhere.
    if (this.clusterProxy) {
      try {
        const url = await this.clusterProxy.ensurePortForward('platform', 'infisical', this.kubeconfigPath);
        this.baseUrlCache = url.replace(/\/$/, '');
        return this.baseUrlCache;
      } catch (err: any) {
        console.warn(`[InfisicalService] port-forward failed, falling back to NodePort lookup: ${err.message}`);
      }
    }

    try {
      const svcJson = await this.infra.runKubectl(
        ['get', 'svc', 'infisical-infisical-standalone-infisical', '-n', NAMESPACE, '-o', 'json'],
        this.kubeconfigPath,
      ).catch(() =>
        this.infra.runKubectl(
          ['get', 'svc', 'infisical', '-n', NAMESPACE, '-o', 'json'],
          this.kubeconfigPath,
        )
      );

      const svc = JSON.parse(svcJson);
      const nodePort =
        svc.spec?.ports?.find((p: any) => p.name === 'http' || p.port === 8080)?.nodePort
        ?? svc.spec?.ports?.[0]?.nodePort
        ?? 31738;

      let host = '127.0.0.1';
      if (process.platform === 'linux') {
        const raw = await this.infra.runKubectl(
          ['get', 'nodes', '-o', 'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}'],
          this.kubeconfigPath,
        ).catch(() => '');
        const parsed = raw.trim().split(/\s+/)[0];
        if (parsed) host = parsed;
      }

      this.baseUrlCache = `http://${host}:${nodePort}`;
      return this.baseUrlCache;
    } catch {
      this.baseUrlCache = 'http://127.0.0.1:31738';
      return this.baseUrlCache;
    }
  }

  async getAdminCredentials(): Promise<{ username: string; password: string }> {
    let adminPassword = 'dev-admin-password-1234';
    try {
      const read = await fs.readFile(ADMIN_PASSWORD_FILE, 'utf8');
      if (read.trim()) adminPassword = read.trim();
    } catch { /* ignored */ }
    return { username: 'admin', password: adminPassword };
  }

  private async loadAuthCreds(): Promise<{ clientId: string; clientSecret: string; orgId: string } | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(AUTH_SECRET_FILE, 'utf8'));
      if (parsed?.clientId && parsed?.clientSecret && parsed?.orgId) return parsed;
    } catch { /* ignored */ }
    return null;
  }

  private async saveAuthCreds(creds: { clientId: string; clientSecret: string; orgId: string }): Promise<void> {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(AUTH_SECRET_FILE, JSON.stringify(creds), 'utf8');
    } catch (err: any) {
      console.warn(`[InfisicalService] could not persist auth credentials: ${err.message}`);
    }
  }

  /**
   * A fresh instance has no credential to log in with — bootstrap it into a permanent, non-expiring
   * Universal Auth machine identity (clientId/clientSecret) instead of relying on the bootstrap
   * response's own identity token, which is a one-off: /admin/bootstrap 400s "already been set up"
   * on every call after the first, so that token can never be re-derived once lost. Runs at most
   * once per instance, ever.
   */
  private async provisionMachineIdentity(): Promise<{ clientId: string; clientSecret: string; orgId: string } | null> {
    const baseUrl = await this.resolveBaseUrl();
    const { password: adminPassword } = await this.getAdminCredentials();

    try {
      const bootstrapRes = await axios.post(
        `${baseUrl}/api/v1/admin/bootstrap`,
        { email: 'admin@provisioning.local', password: adminPassword, organization: 'provisioning' },
        { timeout: 5000, proxy: false },
      );
      const bootstrapToken = bootstrapRes.data?.identity?.credentials?.token;
      const identityId = bootstrapRes.data?.identity?.id;
      const orgId = bootstrapRes.data?.organization?.id;
      if (!bootstrapToken || !identityId || !orgId) return null;

      const headers = { Authorization: `Bearer ${bootstrapToken}` };
      const attachRes = await axios.post(
        `${baseUrl}/api/v1/auth/universal-auth/identities/${identityId}`,
        { accessTokenTTL: 31536000, accessTokenMaxTTL: 31536000, accessTokenNumUsesLimit: 0 },
        { headers, timeout: 5000, proxy: false },
      );
      const clientId = attachRes.data?.identityUniversalAuth?.clientId;
      if (!clientId) return null;

      const secretRes = await axios.post(
        `${baseUrl}/api/v1/auth/universal-auth/identities/${identityId}/client-secrets`,
        { description: 'provisioning backend', ttl: 0, numUsesLimit: 0 },
        { headers, timeout: 5000, proxy: false },
      );
      const clientSecret = secretRes.data?.clientSecret;
      if (!clientSecret) return null;

      const creds = { clientId, clientSecret, orgId };
      await this.saveAuthCreds(creds);
      return creds;
    } catch (err: any) {
      console.warn(`[InfisicalService] could not provision a machine identity: ${err.message}`);
      return null;
    }
  }

  async authenticate(): Promise<string> {
    if (this.tokenCache) return this.tokenCache;

    const creds = (await this.loadAuthCreds()) ?? (await this.provisionMachineIdentity());
    if (!creds) throw new Error('Infisical has no machine identity and one could not be provisioned');
    this.orgId = creds.orgId;

    const baseUrl = await this.resolveBaseUrl();
    const res = await axios.post(
      `${baseUrl}/api/v1/auth/universal-auth/login`,
      { clientId: creds.clientId, clientSecret: creds.clientSecret },
      { timeout: 5000, proxy: false },
    );
    const token = res.data?.accessToken;
    if (!token) throw new Error('Infisical login returned no access token');
    this.tokenCache = token;
    return token;
  }

  private async authorized<T>(call: (token: string, baseUrl: string) => Promise<T>): Promise<T> {
    const baseUrl = await this.resolveBaseUrl();
    try {
      return await call(await this.authenticate(), baseUrl);
    } catch (err: any) {
      if (err?.response?.status !== 401) throw err;
      this.tokenCache = null;
      return call(await this.authenticate(), baseUrl);
    }
  }

  private async ensureWorkspace(projectId: string): Promise<string> {
    const cached = this.workspaceCache.get(projectId);
    if (cached) return cached;

    const projectName = `provisioning-${projectId}`;
    const id = await this.authorized(async (token, baseUrl) => {
      const headers = { Authorization: `Bearer ${token}` };
      const list = await axios.get(`${baseUrl}/api/v1/workspace`, { headers, timeout: 4000, proxy: false });
      const found = (list.data?.workspaces ?? []).find((w: any) => w.name === projectName);
      if (found?.id) return found.id as string;
      const created = await axios.post(
        `${baseUrl}/api/v2/workspace`,
        { projectName, organizationId: this.orgId },
        { headers, timeout: 4000, proxy: false },
      );
      return created.data?.project?.id as string | undefined;
    });
    if (!id) throw new Error(`Infisical did not return a workspace for ${projectId}`);
    this.workspaceCache.set(projectId, id);
    return id;
  }

  async getSecret(projectId: string, key: string, environment = 'dev'): Promise<string | null> {
    const workspaceId = await this.ensureWorkspace(projectId);
    try {
      const res = await this.authorized((token, baseUrl) => axios.get(
        `${baseUrl}/api/v3/secrets/raw/${encodeURIComponent(key)}`,
        { params: { workspaceId, environment }, headers: { Authorization: `Bearer ${token}` }, timeout: 4000, proxy: false },
      ));
      return res.data?.secret?.secretValue ?? null;
    } catch (err: any) {
      if (err?.response?.status === 404) return null;
      throw err;
    }
  }

  async hasSecret(projectId: string, key: string, environment = 'dev'): Promise<boolean> {
    return (await this.getSecret(projectId, key, environment)) !== null;
  }

  async setSecret(
    projectId: string,
    key: string,
    value: string,
    comment?: string | undefined,
    environment = 'dev',
  ): Promise<{ secretReference: string }> {
    const workspaceId = await this.ensureWorkspace(projectId);
    const body = {
      workspaceId,
      environment,
      secretValue: value,
      secretComment: comment ?? 'Managed by provisioning platform',
    };
    await this.authorized(async (token, baseUrl) => {
      const headers = { Authorization: `Bearer ${token}` };
      const url = `${baseUrl}/api/v3/secrets/raw/${encodeURIComponent(key)}`;
      await axios.post(url, body, { headers, timeout: 4000, proxy: false }).catch(async (err: any) => {
        if (err.response?.status !== 400) throw err;
        await axios.patch(url, body, { headers, timeout: 4000, proxy: false });
      });
    });
    return { secretReference: `secret://${projectId}/${key}` };
  }

  async deleteSecret(projectId: string, key: string, environment = 'dev'): Promise<void> {
    const workspaceId = await this.ensureWorkspace(projectId);
    try {
      await this.authorized((token, baseUrl) => axios.delete(
        `${baseUrl}/api/v3/secrets/raw/${encodeURIComponent(key)}`,
        { data: { workspaceId, environment }, headers: { Authorization: `Bearer ${token}` }, timeout: 4000, proxy: false },
      ));
    } catch (err: any) {
      if (err?.response?.status !== 404) throw err;
    }
  }

  async listSecrets(projectId: string, environment = 'dev'): Promise<InfisicalSecretRecord[]> {
    const workspaceId = await this.ensureWorkspace(projectId);
    const res = await this.authorized((token, baseUrl) => axios.get(
      `${baseUrl}/api/v3/secrets/raw`,
      { params: { workspaceId, environment }, headers: { Authorization: `Bearer ${token}` }, timeout: 4000, proxy: false },
    ));
    return (res.data?.secrets ?? []).map((s: any) => ({
      key: s.secretKey,
      secretReference: `secret://${projectId}/${s.secretKey}`,
      version: s.version ?? 1,
      ...(s.secretComment ? { comment: s.secretComment } : {}),
    }));
  }

  async removeProject(projectId: string): Promise<{ workspace: boolean; readers: number }> {
    this.workspaceCache.delete(projectId);
    return this.authorized(async (token, baseUrl) => {
      const options = { headers: { Authorization: `Bearer ${token}` }, timeout: 8000, proxy: false as const };
      const prefix = `reader-${projectId}-`;
      const memberships = await axios.get(`${baseUrl}/api/v2/organizations/${this.orgId}/identity-memberships`, options);
      const readers = ((memberships.data?.identityMemberships ?? []) as { identity?: { id?: string; name?: string } }[])
        .map((membership) => membership.identity)
        .filter((identity): identity is { id: string; name: string } => typeof identity?.id === 'string' && (identity.name ?? '').startsWith(prefix));
      for (const reader of readers) await axios.delete(`${baseUrl}/api/v1/identities/${reader.id}`, options);
      const listed = await axios.get(`${baseUrl}/api/v1/workspace`, options);
      const workspace = ((listed.data?.workspaces ?? []) as { id?: string; name?: string }[]).find((entry) => entry.name === `provisioning-${projectId}`);
      if (workspace?.id) await axios.delete(`${baseUrl}/api/v1/workspace/${workspace.id}`, options);
      return { workspace: Boolean(workspace?.id), readers: readers.length };
    });
  }

  async workspaceIdFor(projectId: string): Promise<string> {
    return this.ensureWorkspace(projectId);
  }

  async createProjectReader(projectId: string): Promise<{ clientId: string; clientSecret: string }> {
    const workspaceId = await this.ensureWorkspace(projectId);
    return this.authorized(async (token, baseUrl) => {
      const headers = { Authorization: `Bearer ${token}` };
      const options = { headers, timeout: 8000, proxy: false as const };
      const identity = await axios.post(
        `${baseUrl}/api/v1/identities`,
        { name: `reader-${projectId}-${Date.now().toString(36)}`, organizationId: this.orgId, role: 'no-access' },
        options,
      );
      const identityId = identity.data?.identity?.id;
      if (!identityId) throw new Error('Infisical did not return the new identity');
      const auth = await axios.post(
        `${baseUrl}/api/v1/auth/universal-auth/identities/${identityId}`,
        { accessTokenTTL: 2592000, accessTokenMaxTTL: 2592000, accessTokenNumUsesLimit: 0 },
        options,
      );
      const clientId = auth.data?.identityUniversalAuth?.clientId;
      const secret = await axios.post(
        `${baseUrl}/api/v1/auth/universal-auth/identities/${identityId}/client-secrets`,
        { description: `operator reader for ${projectId}`, ttl: 0, numUsesLimit: 0 },
        options,
      );
      const clientSecret = secret.data?.clientSecret;
      if (!clientId || !clientSecret) throw new Error('Infisical did not return a client credential for the reader');
      await axios.post(
        `${baseUrl}/api/v2/workspace/${workspaceId}/identity-memberships/${identityId}`,
        { role: 'viewer' },
        options,
      );
      return { clientId, clientSecret };
    });
  }
}
