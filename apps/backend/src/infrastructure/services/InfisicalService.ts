import { listAt, numberAt, textAt } from '../../platform/index.js';
import type { SecretKey } from '../../platform/index.js';
import path from 'path';
import fs from 'fs/promises';
import axios from 'axios';
import type { InfrastructureService } from './InfrastructureService.js';
import type { ClusterProxyService } from './ClusterProxyService.js';
import { readerNameFor, readerPrefixFor, workspaceNameFor } from '../lib/infisical-names.js';
import { infisicalAdminPassword } from '../lib/infisical-admin.js';
import { ignore } from '@koala/engine-core/failures';

const NAMESPACE = 'infisical';
const DATA_DIR = path.join(process.cwd(), 'data');
const IDENTITY_FILE = path.join(DATA_DIR, '.infisical-machine-identity');
const SHARED_AUTH_SECRET_FILE = path.join(DATA_DIR, '.infisical-auth-secret');
const ADMIN_PASSWORD_FILE = path.join(DATA_DIR, '.infisical-admin-password');

export interface InfisicalSecretRecord {
  key: string;
  secretReference: string;
  version?: number | undefined;
  comment?: string | undefined;
}

async function readIdentity(file: string): Promise<{ clientId: string; clientSecret: string; orgId: string } | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    const clientId = textAt(parsed, 'clientId');
    const clientSecret = textAt(parsed, 'clientSecret');
    const orgId = textAt(parsed, 'orgId');
    if (clientId && clientSecret && orgId) return { clientId, clientSecret, orgId };
  } catch (failure) {
    ignore('an identity file that is missing or unreadable holds no identity to log in with')(failure);
  }
  return null;
}

const statusOf = (err: unknown): number | undefined => numberAt(err, 'response', 'status');

const messageOf = (err: unknown): string => (err as Error | undefined)?.message ?? String(err);

const workspaceGone = (err: unknown): boolean =>
  statusOf(err) === 404 && /^Project with ID /.test(textAt(err, 'response', 'data', 'message') ?? '');

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
    private readonly clusterProxy?: Pick<ClusterProxyService, 'serviceUrl'>,
  ) {}

  async resolveBaseUrl(): Promise<string> {
    if (this.customBaseUrl) return this.customBaseUrl;
    if (process.env.INFISICAL_URL?.trim()) return process.env.INFISICAL_URL.trim().replace(/\/+$/, '');
    if (this.baseUrlCache) return this.baseUrlCache;

    if (this.clusterProxy) {
      try {
        const url = await this.clusterProxy.serviceUrl('platform', 'infisical', this.kubeconfigPath);
        this.baseUrlCache = url.replace(/\/$/, '');
        return this.baseUrlCache;
      } catch (err) {
        console.warn(`[InfisicalService] could not reach Infisical inside the cluster, falling back to NodePort lookup: ${messageOf(err)}`);
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

      const ports = listAt(JSON.parse(svcJson) as unknown, 'spec', 'ports');
      const nodePort =
        numberAt(ports.find((p) => textAt(p, 'name') === 'http' || numberAt(p, 'port') === 8080), 'nodePort')
        ?? numberAt(ports[0], 'nodePort')
        ?? 31738;

      let host = '127.0.0.1';
      if (process.platform === 'linux') {
        const raw = await this.infra.runKubectl(
          ['get', 'nodes', '-o', 'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}'],
          this.kubeconfigPath,
        ).catch(ignore('without the node\'s address Infisical is reached on this machine\'s loopback'));
        const parsed = raw?.trim().split(/\s+/)[0];
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
    const stored = await fs.readFile(ADMIN_PASSWORD_FILE, 'utf8').catch(ignore('with no stored password infisicalAdminPassword gives the development one, and refuses in production'));
    return { username: 'admin', password: infisicalAdminPassword(stored, process.env.NODE_ENV === 'production', ADMIN_PASSWORD_FILE) };
  }

  private async loadAuthCreds(): Promise<{ clientId: string; clientSecret: string; orgId: string } | null> {
    const own = await readIdentity(IDENTITY_FILE);
    if (own) return own;
    const shared = await readIdentity(SHARED_AUTH_SECRET_FILE);
    if (shared) await this.saveAuthCreds(shared);
    return shared;
  }

  private async saveAuthCreds(creds: { clientId: string; clientSecret: string; orgId: string }): Promise<void> {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(IDENTITY_FILE, JSON.stringify(creds), { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      console.warn(`[InfisicalService] could not persist auth credentials: ${messageOf(err)}`);
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
      const bootstrapRes = await axios.post<unknown>(
        `${baseUrl}/api/v1/admin/bootstrap`,
        { email: 'admin@provisioning.local', password: adminPassword, organization: 'provisioning' },
        { timeout: 5000, proxy: false },
      );
      const bootstrapToken = textAt(bootstrapRes.data, 'identity', 'credentials', 'token');
      const identityId = textAt(bootstrapRes.data, 'identity', 'id');
      const orgId = textAt(bootstrapRes.data, 'organization', 'id');
      if (!bootstrapToken || !identityId || !orgId) return null;

      const headers = { Authorization: `Bearer ${bootstrapToken}` };
      const attachRes = await axios.post<unknown>(
        `${baseUrl}/api/v1/auth/universal-auth/identities/${identityId}`,
        { accessTokenTTL: 31536000, accessTokenMaxTTL: 31536000, accessTokenNumUsesLimit: 0 },
        { headers, timeout: 5000, proxy: false },
      );
      const clientId = textAt(attachRes.data, 'identityUniversalAuth', 'clientId');
      if (!clientId) return null;

      const secretRes = await axios.post<unknown>(
        `${baseUrl}/api/v1/auth/universal-auth/identities/${identityId}/client-secrets`,
        { description: 'provisioning backend', ttl: 0, numUsesLimit: 0 },
        { headers, timeout: 5000, proxy: false },
      );
      const clientSecret = textAt(secretRes.data, 'clientSecret');
      if (!clientSecret) return null;

      const creds = { clientId, clientSecret, orgId };
      await this.saveAuthCreds(creds);
      return creds;
    } catch (err) {
      console.warn(`[InfisicalService] could not provision a machine identity: ${messageOf(err)}`);
      return null;
    }
  }

  async authenticate(): Promise<string> {
    if (this.tokenCache) return this.tokenCache;

    const stored = await this.loadAuthCreds();
    let creds = stored;
    let token = stored ? await this.login(stored) : undefined;
    if (!token) {
      this.workspaceCache.clear();
      creds = await this.provisionMachineIdentity();
      if (!creds) {
        throw new Error(stored
          ? 'Infisical refuses the machine identity in data/.infisical-machine-identity and is not new, so another cannot be made'
          : 'Infisical has no machine identity and one could not be provisioned');
      }
      token = await this.login(creds);
      if (!token) throw new Error('Infisical refused the machine identity it just made');
    }
    this.orgId = creds!.orgId;
    this.tokenCache = token;
    return token;
  }

  async readerWorks(reader: { clientId: string; clientSecret: string }): Promise<boolean> {
    return (await this.login(reader)) !== undefined;
  }

  private async login(creds: { clientId: string; clientSecret: string }): Promise<string | undefined> {
    const baseUrl = await this.resolveBaseUrl();
    try {
      const res = await axios.post<unknown>(
        `${baseUrl}/api/v1/auth/universal-auth/login`,
        { clientId: creds.clientId, clientSecret: creds.clientSecret },
        { timeout: 5000, proxy: false },
      );
      const token = textAt(res.data, 'accessToken');
      if (!token) throw new Error('Infisical login returned no access token');
      return token;
    } catch (err) {
      if (statusOf(err) === 401) return undefined;
      throw err;
    }
  }

  private async authorized<T>(call: (token: string, baseUrl: string) => Promise<T>): Promise<T> {
    const baseUrl = await this.resolveBaseUrl();
    try {
      return await call(await this.authenticate(), baseUrl);
    } catch (err) {
      if (statusOf(err) !== 401) throw err;
      this.tokenCache = null;
      return call(await this.authenticate(), baseUrl);
    }
  }

  private async ensureWorkspace(projectId: string): Promise<string> {
    const cached = this.workspaceCache.get(projectId);
    if (cached) return cached;

    const projectName = workspaceNameFor(projectId);
    const id = await this.authorized(async (token, baseUrl) => {
      const headers = { Authorization: `Bearer ${token}` };
      const list = await axios.get<unknown>(`${baseUrl}/api/v1/workspace`, { headers, timeout: 4000, proxy: false });
      const foundId = textAt(listAt(list.data, 'workspaces').find((w) => textAt(w, 'name') === projectName), 'id');
      if (foundId) return foundId;
      const created = await axios.post<unknown>(
        `${baseUrl}/api/v2/workspace`,
        { projectName, organizationId: this.orgId },
        { headers, timeout: 4000, proxy: false },
      );
      return textAt(created.data, 'project', 'id');
    });
    if (!id) throw new Error(`Infisical did not return a workspace for ${projectId}`);
    this.workspaceCache.set(projectId, id);
    return id;
  }

  private async inWorkspace<T>(projectId: string, call: (workspaceId: string) => Promise<T>): Promise<T> {
    try {
      return await call(await this.ensureWorkspace(projectId));
    } catch (err) {
      if (!workspaceGone(err)) throw err;
      this.workspaceCache.delete(projectId);
      return call(await this.ensureWorkspace(projectId));
    }
  }

  async getSecret(projectId: string, key: string, environment = 'dev'): Promise<string | null> {
    return this.inWorkspace(projectId, async (workspaceId) => {
      try {
        const res = await this.authorized((token, baseUrl) => axios.get<unknown>(
          `${baseUrl}/api/v3/secrets/raw/${encodeURIComponent(key)}`,
          { params: { workspaceId, environment }, headers: { Authorization: `Bearer ${token}` }, timeout: 4000, proxy: false },
        ));
        return textAt(res.data, 'secret', 'secretValue') ?? null;
      } catch (err) {
        if (statusOf(err) === 404 && !workspaceGone(err)) return null;
        throw err;
      }
    });
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
    await this.inWorkspace(projectId, async (workspaceId) => {
      const body = {
        workspaceId,
        environment,
        secretValue: value,
        secretComment: comment ?? 'Managed by provisioning platform',
      };
      await this.authorized(async (token, baseUrl) => {
        const headers = { Authorization: `Bearer ${token}` };
        const url = `${baseUrl}/api/v3/secrets/raw/${encodeURIComponent(key)}`;
        await axios.post(url, body, { headers, timeout: 4000, proxy: false }).catch(async (err: unknown) => {
          if (statusOf(err) !== 400) throw err;
          await axios.patch(url, body, { headers, timeout: 4000, proxy: false });
        });
      });
    });
    return { secretReference: `secret://${projectId}/${key}` };
  }

  async deleteSecret(projectId: string, key: string, environment = 'dev'): Promise<void> {
    await this.inWorkspace(projectId, async (workspaceId) => {
      try {
        await this.authorized((token, baseUrl) => axios.delete(
          `${baseUrl}/api/v3/secrets/raw/${encodeURIComponent(key)}`,
          { data: { workspaceId, environment }, headers: { Authorization: `Bearer ${token}` }, timeout: 4000, proxy: false },
        ));
      } catch (err) {
        if (statusOf(err) !== 404 || workspaceGone(err)) throw err;
      }
    });
  }

  async listSecrets(projectId: string, environment = 'dev'): Promise<InfisicalSecretRecord[]> {
    const res = await this.inWorkspace(projectId, (workspaceId) => this.authorized((token, baseUrl) => axios.get<unknown>(
      `${baseUrl}/api/v3/secrets/raw`,
      { params: { workspaceId, environment }, headers: { Authorization: `Bearer ${token}` }, timeout: 4000, proxy: false },
    )));
    return listAt(res.data, 'secrets').flatMap((s) => {
      const key = textAt(s, 'secretKey');
      if (key === undefined) return [];
      const comment = textAt(s, 'secretComment');
      return [{
        key,
        secretReference: `secret://${projectId}/${key}`,
        version: numberAt(s, 'version') ?? 1,
        ...(comment ? { comment } : {}),
      }];
    });
  }

  async removeProject(projectId: string): Promise<{ workspace: boolean; readers: number }> {
    this.workspaceCache.delete(projectId);
    return this.authorized(async (token, baseUrl) => {
      const options = { headers: { Authorization: `Bearer ${token}` }, timeout: 8000, proxy: false as const };
      const prefix = readerPrefixFor(projectId);
      const memberships = await axios.get<unknown>(`${baseUrl}/api/v2/organizations/${this.orgId}/identity-memberships`, options);
      const readers = listAt(memberships.data, 'identityMemberships')
        .map((membership) => ({ id: textAt(membership, 'identity', 'id'), name: textAt(membership, 'identity', 'name') ?? '' }))
        .filter((identity): identity is { id: string; name: string } => identity.id !== undefined && identity.name.startsWith(prefix));
      for (const reader of readers) await axios.delete(`${baseUrl}/api/v1/identities/${reader.id}`, options);
      const listed = await axios.get<unknown>(`${baseUrl}/api/v1/workspace`, options);
      const workspaceId = textAt(listAt(listed.data, 'workspaces').find((entry) => textAt(entry, 'name') === workspaceNameFor(projectId)), 'id');
      if (workspaceId) await axios.delete(`${baseUrl}/api/v1/workspace/${workspaceId}`, options);
      return { workspace: Boolean(workspaceId), readers: readers.length };
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
      const identity = await axios.post<unknown>(
        `${baseUrl}/api/v1/identities`,
        { name: readerNameFor(projectId, Date.now()), organizationId: this.orgId, role: 'no-access' },
        options,
      );
      const identityId = textAt(identity.data, 'identity', 'id');
      if (!identityId) throw new Error('Infisical did not return the new identity');
      const auth = await axios.post<unknown>(
        `${baseUrl}/api/v1/auth/universal-auth/identities/${identityId}`,
        { accessTokenTTL: 2592000, accessTokenMaxTTL: 2592000, accessTokenNumUsesLimit: 0 },
        options,
      );
      const clientId = textAt(auth.data, 'identityUniversalAuth', 'clientId');
      const secret = await axios.post<unknown>(
        `${baseUrl}/api/v1/auth/universal-auth/identities/${identityId}/client-secrets`,
        { description: `operator reader for ${projectId}`, ttl: 0, numUsesLimit: 0 },
        options,
      );
      const clientSecret = textAt(secret.data, 'clientSecret');
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
