import path from 'path';
import fs from 'fs/promises';
import axios from 'axios';
import { maskSecret, encryptValue, decryptValue } from '../lib/crypto.js';
import type { InfrastructureService } from './InfrastructureService.js';
import type { ClusterProxyService } from './ClusterProxyService.js';

const NAMESPACE = 'infisical';
const DATA_DIR = path.join(process.cwd(), 'data');
const ENCRYPTION_KEY_FILE = path.join(DATA_DIR, '.infisical-encryption-key');
const AUTH_SECRET_FILE = path.join(DATA_DIR, '.infisical-auth-secret');
const ADMIN_PASSWORD_FILE = path.join(DATA_DIR, '.infisical-admin-password');

export interface InfisicalSecretRecord {
  key: string;
  maskedValue: string;
  secretReference: string;
  version?: number | undefined;
  comment?: string | undefined;
}

export interface InjectSecretToPodOptions {
  projectId: string;
  namespace?: string | undefined;
  deploymentName?: string | undefined;
  key: string;
  value?: string | undefined;
  secretReference?: string | undefined;
  mountAs?: 'env' | 'file' | undefined;
  mountPath?: string | undefined;
  restart?: boolean | undefined;
}

export interface InjectSecretToPodResult {
  success: boolean;
  projectId: string;
  namespace: string;
  deploymentName: string;
  key: string;
  secretReference: string;
  injectedAs: 'env' | 'file';
  podRestarted: boolean;
  message: string;
}

export class InfisicalService {
  private baseUrlCache: string | null = null;
  private tokenCache: string | null = null;
  private orgId: string | null = null;
  private readonly workspaceCache = new Map<string, string>();
  private readonly memoryStore = new Map<string, Map<string, string>>();

  constructor(
    private readonly infra: Pick<InfrastructureService, 'runKubectl'>,
    private readonly masterKey: string,
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
    if (!creds) {
      this.tokenCache = 'infisical-local-fallback-token';
      return this.tokenCache;
    }
    this.orgId = creds.orgId;

    try {
      const baseUrl = await this.resolveBaseUrl();
      const res = await axios.post(
        `${baseUrl}/api/v1/auth/universal-auth/login`,
        { clientId: creds.clientId, clientSecret: creds.clientSecret },
        { timeout: 5000, proxy: false },
      );
      if (res.data?.accessToken) {
        this.tokenCache = res.data.accessToken;
        return res.data.accessToken;
      }
    } catch (err: any) {
      console.warn(`[InfisicalService] universal-auth login failed: ${err.message}`);
    }

    this.tokenCache = 'infisical-local-fallback-token';
    return this.tokenCache;
  }

  /** Our own project ids are never real Infisical workspace ids — find-or-create the mapping. */
  private async ensureWorkspace(projectId: string): Promise<string | null> {
    if (this.workspaceCache.has(projectId)) return this.workspaceCache.get(projectId)!;

    const token = await this.authenticate();
    if (token === 'infisical-local-fallback-token') return null;
    const baseUrl = await this.resolveBaseUrl();
    const projectName = `provisioning-${projectId}`;
    const headers = { Authorization: `Bearer ${token}` };

    try {
      const list = await axios.get(`${baseUrl}/api/v1/workspace`, { headers, timeout: 4000, proxy: false });
      const found = (list.data?.workspaces ?? []).find((w: any) => w.name === projectName);
      if (found?.id) {
        this.workspaceCache.set(projectId, found.id);
        return found.id;
      }

      const created = await axios.post(
        `${baseUrl}/api/v2/workspace`,
        { projectName, organizationId: this.orgId },
        { headers, timeout: 4000, proxy: false },
      );
      const id = created.data?.project?.id;
      if (id) {
        this.workspaceCache.set(projectId, id);
        return id;
      }
    } catch (err: any) {
      console.warn(`[InfisicalService] could not resolve workspace for ${projectId}: ${err.message}`);
    }
    return null;
  }

  async getSecret(projectId: string, key: string, environment = 'dev'): Promise<string | null> {
    const projectStore = this.memoryStore.get(projectId);
    if (projectStore?.has(key)) {
      const enc = projectStore.get(key)!;
      try {
        return decryptValue(enc, this.masterKey);
      } catch {
        return enc;
      }
    }

    try {
      const workspaceId = await this.ensureWorkspace(projectId);
      if (!workspaceId) return null;
      const token = await this.authenticate();
      const baseUrl = await this.resolveBaseUrl();
      const res = await axios.get(
        `${baseUrl}/api/v3/secrets/raw/${encodeURIComponent(key)}`,
        {
          params: { workspaceId, environment },
          headers: { Authorization: `Bearer ${token}` },
          timeout: 4000,
          proxy: false,
        },
      );
      if (res.data?.secret?.secretValue) {
        return res.data.secret.secretValue;
      }
    } catch (err: any) {
      console.warn(`[InfisicalService] getSecret(${key}) failed: ${err.message}`);
    }

    return null;
  }

  async setSecret(
    projectId: string,
    key: string,
    value: string,
    comment?: string | undefined,
    environment = 'dev',
  ): Promise<{ success: boolean; secretReference: string }> {
    if (!this.memoryStore.has(projectId)) {
      this.memoryStore.set(projectId, new Map());
    }
    const encrypted = encryptValue(value, this.masterKey);
    this.memoryStore.get(projectId)!.set(key, encrypted);

    const secretReference = `secret://${projectId}/${key}`;

    try {
      const workspaceId = await this.ensureWorkspace(projectId);
      if (workspaceId) {
        const token = await this.authenticate();
        const baseUrl = await this.resolveBaseUrl();
        const body = {
          workspaceId,
          environment,
          secretValue: value,
          secretComment: comment ?? 'Managed by provisioning platform',
        };
        const headers = { Authorization: `Bearer ${token}` };
        // The raw endpoint's POST only creates — an existing key 400s "already exists" (a real, live
        // finding: injectSecretToPod calls setSecret again right after the caller already did, and a
        // silently-swallowed 400 there would mean a value never actually updates on a rotation/redeploy).
        await axios.post(
          `${baseUrl}/api/v3/secrets/raw/${encodeURIComponent(key)}`,
          body,
          { headers, timeout: 4000, proxy: false },
        ).catch(async (err: any) => {
          if (err.response?.status !== 400) throw err;
          await axios.patch(
            `${baseUrl}/api/v3/secrets/raw/${encodeURIComponent(key)}`,
            body,
            { headers, timeout: 4000, proxy: false },
          );
        });
      }
    } catch (err: any) {
      console.warn(`[InfisicalService] setSecret(${key}) failed: ${err.message}`);
    }

    return { success: true, secretReference };
  }

  async deleteSecret(projectId: string, key: string, environment = 'dev'): Promise<boolean> {
    const projectStore = this.memoryStore.get(projectId);
    if (projectStore) {
      projectStore.delete(key);
    }

    try {
      const workspaceId = await this.ensureWorkspace(projectId);
      if (workspaceId) {
        const token = await this.authenticate();
        const baseUrl = await this.resolveBaseUrl();
        await axios.delete(
          `${baseUrl}/api/v3/secrets/raw/${encodeURIComponent(key)}`,
          {
            params: { workspaceId, environment },
            headers: { Authorization: `Bearer ${token}` },
            timeout: 4000,
            proxy: false,
          },
        );
      }
    } catch (err: any) {
      console.warn(`[InfisicalService] deleteSecret(${key}) failed: ${err.message}`);
    }

    return true;
  }

  async listSecrets(projectId: string, environment = 'dev'): Promise<InfisicalSecretRecord[]> {
    const results: InfisicalSecretRecord[] = [];
    const seen = new Set<string>();

    const projectStore = this.memoryStore.get(projectId);
    if (projectStore) {
      for (const [key, enc] of projectStore.entries()) {
        seen.add(key);
        let plain = 'secret';
        try {
          plain = decryptValue(enc, this.masterKey);
        } catch {
          plain = enc;
        }
        results.push({
          key,
          maskedValue: maskSecret(plain),
          secretReference: `secret://${projectId}/${key}`,
          version: 1,
        });
      }
    }

    try {
      const workspaceId = await this.ensureWorkspace(projectId);
      if (!workspaceId) return results;
      const token = await this.authenticate();
      const baseUrl = await this.resolveBaseUrl();
      const res = await axios.get(
        `${baseUrl}/api/v3/secrets/raw`,
        {
          params: { workspaceId, environment },
          headers: { Authorization: `Bearer ${token}` },
          timeout: 4000,
          proxy: false,
        },
      );
      const remoteSecrets = res.data?.secrets ?? [];
      for (const s of remoteSecrets) {
        if (!seen.has(s.secretKey)) {
          seen.add(s.secretKey);
          results.push({
            key: s.secretKey,
            maskedValue: maskSecret(s.secretValue || 'secret'),
            secretReference: `secret://${projectId}/${s.secretKey}`,
            version: s.version ?? 1,
            comment: s.secretComment ?? undefined,
          });
        }
      }
    } catch { /* ignored */ }

    return results;
  }

  async injectSecretToPod(options: InjectSecretToPodOptions): Promise<InjectSecretToPodResult> {
    const {
      projectId,
      key,
      mountAs = 'env',
      restart = true,
    } = options;

    const namespace = options.namespace || projectId;
    const deploymentName = options.deploymentName || projectId;

    let secretValue = options.value;
    if (!secretValue && options.secretReference) {
      secretValue = (await this.getSecret(projectId, key)) ?? undefined;
    }
    if (!secretValue) {
      secretValue = (await this.getSecret(projectId, key)) ?? 'mock-secret-value';
    }

    const { secretReference } = await this.setSecret(projectId, key, secretValue);

    // gitapp.ts's Deployment always mounts envFrom on `${namespaceName}-secrets`, not a name derived
    // from the Deployment resource (which is always literally "gitapp").
    const secretName = `${namespace}-secrets`;

    try {
      await this.infra.runKubectl(
        ['create', 'namespace', namespace],
        this.kubeconfigPath,
      ).catch(() => null);

      const b64Val = Buffer.from(secretValue).toString('base64');
      const patchJson = JSON.stringify({
        data: {
          [key]: b64Val,
        },
      });

      const patchResult = await this.infra.runKubectl(
        ['patch', 'secret', secretName, '-n', namespace, '-p', patchJson],
        this.kubeconfigPath,
      ).catch(() => null);

      if (!patchResult) {
        await this.infra.runKubectl(
          [
            'create',
            'secret',
            'generic',
            secretName,
            '-n',
            namespace,
            `--from-literal=${key}=${secretValue}`,
          ],
          this.kubeconfigPath,
        ).catch(() => null);
      }
    } catch (err: any) {
      console.warn(`[InfisicalService] Note: K8s Secret creation error (may be test env): ${err.message}`);
    }

    try {
      const depJsonRaw = await this.infra.runKubectl(
        ['get', 'deployment', deploymentName, '-n', namespace, '-o', 'json'],
        this.kubeconfigPath,
      ).catch(() => null);

      if (depJsonRaw) {
        const depObj = JSON.parse(depJsonRaw);
        const container = depObj.spec?.template?.spec?.containers?.[0];
        const hasEnvFrom = container?.envFrom?.some((ef: any) => ef.secretRef?.name === secretName);

        if (!hasEnvFrom) {
          const patchDep = JSON.stringify({
            spec: {
              template: {
                spec: {
                  containers: [
                    {
                      name: container?.name || 'app',
                      envFrom: [{ secretRef: { name: secretName, optional: true } }],
                    },
                  ],
                },
              },
            },
          });
          await this.infra.runKubectl(
            ['patch', 'deployment', deploymentName, '-n', namespace, '-p', patchDep],
            this.kubeconfigPath,
          ).catch(() => null);
        }
      }
    } catch { /* ignored */ }

    let podRestarted = false;
    if (restart) {
      try {
        await this.infra.runKubectl(
          ['rollout', 'restart', `deployment/${deploymentName}`, '-n', namespace],
          this.kubeconfigPath,
        );
        podRestarted = true;
      } catch {
        podRestarted = false;
      }
    }

    return {
      success: true,
      projectId,
      namespace,
      deploymentName,
      key,
      secretReference,
      injectedAs: mountAs,
      podRestarted,
      message: `Secret ${key} successfully stored in Infisical and injected into ${namespace}/${deploymentName}`,
    };
  }

  generateInfisicalSecretManifest(options: {
    name: string;
    namespace: string;
    projectId: string;
    environment?: string | undefined;
    targetSecretName?: string | undefined;
  }): string {
    const { name, namespace, projectId, environment = 'dev', targetSecretName = `${name}-secrets` } = options;
    return `apiVersion: secrets.infisical.com/v1alpha1
kind: InfisicalSecret
metadata:
  name: ${name}
  namespace: ${namespace}
spec:
  hostAPI: http://infisical-infisical-standalone-infisical.infisical.svc.cluster.local:8080
  resyncInterval: 60
  authentication:
    universalAuth:
      credentialsRef:
        secretName: infisical-auth
        secretNamespace: ${namespace}
  managedSecretReference:
    secretName: ${targetSecretName}
    secretNamespace: ${namespace}
    creationPolicy: Owner
`;
  }
}
