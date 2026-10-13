import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { InfrastructureService } from '../services/InfrastructureService.js';
import { GiteaService } from '../services/GiteaService.js';
import { loadKeys } from '../lib/keys.js';
import { CHART_DIR, NOTHING_INSTALLED, copyDatabaseScript, modulesIn, slotStateFrom, type ReleaseVault, type Slot, type SlotState } from '../lib/odoo-release.js';
import { createDatabase } from '../lib/db-interface.js';
import { hasCloudCredentials } from '../lib/credential-resolver.js';
import { isMockCloudProvider } from '../lib/cluster-topology.js';
import type { ClusterMetadata } from '../lib/types.js';
import type { SecretTarget } from '../lib/infisical-sync.js';
import { InfisicalService } from '../services/InfisicalService.js';
import { ClusterProxyService } from '../services/ClusterProxyService.js';
import { syncProjectSecrets } from '../services/ProjectSecretSync.js';
import { reachCluster, type ClusterRef } from './cluster-access.js';
import { inNamespace, runClusterJob, type NamespacedCluster } from './cluster-jobs.js';
import { QUIET_PREVIEW_SQL } from '../lib/release-e2e.js';
import { resolveKubeconfig } from './RunPipelineActivity.js';
import { labelValue } from '../engine-host/sandboxes/workspace.js';

export interface ReleaseTarget extends ClusterRef {
  namespace: string;
  release: string;
  owner?: { ownerId: string; projectId: string } | undefined;
}

export function releaseNamespace(target: Pick<ReleaseTarget, 'namespace' | 'owner'>): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: target.namespace,
      ...(target.owner ? { labels: { 'koala.dev/owner': labelValue(target.owner.ownerId), 'koala.dev/project': labelValue(target.owner.projectId) } } : {}),
    },
  };
}

export interface ReleaseSource {
  owner: string;
  repo: string;
  commit: string;
}

const POLL_MS = 5_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const beat = (detail?: unknown) => { try { Context.current().heartbeat(detail); } catch { return; } };
const notFound = (err: unknown): boolean => /not found|NotFound/i.test(String((err as Error)?.message ?? err));

async function gitea(infra: InfrastructureService): Promise<GiteaService> {
  return new GiteaService(infra, loadKeys(process.env).data, await resolveKubeconfig(infra));
}

export interface VaultSyncArgs {
  projectId: string;
  namespace: string;
  secretName: string;
  kubeconfig: string;
  target: SecretTarget;
}

export type VaultSync = (args: VaultSyncArgs) => Promise<void>;

const VAULT_WAIT_MS = 3 * 60_000;

export const syncVaultFromProject = (infra: InfrastructureService): VaultSync => async (args) => {
  const db = createDatabase();
  await db.init();
  try {
    const project = (await db.getProjects()).find((entry) => entry.id === args.projectId);
    if (!project) throw ApplicationFailure.nonRetryable(`the project ${args.projectId} is gone, so its vault cannot be synced`);
    const masterKey = loadKeys(process.env).data;
    const vault = new InfisicalService(infra, masterKey, '/tmp/kubeconfig-provisioning-lunorica', undefined, new ClusterProxyService());
    await syncProjectSecrets({ infra, vault, projects: db, masterKey }, { project, namespace: args.namespace, kubeconfig: args.kubeconfig, target: args.target, secretName: args.secretName });
  } finally {
    await db.close().catch(() => undefined);
  }
};

export function createOdooReleaseActivities(infra: InfrastructureService = new InfrastructureService(), syncVault: VaultSync = syncVaultFromProject(infra)) {
  const kubeconfigOf = (target: ReleaseTarget) => reachCluster(infra, target);
  const kubectl = async (target: ReleaseTarget, args: string[]) => infra.runKubectl(['-n', target.namespace, ...args], await kubeconfigOf(target));
  const namespaced = (target: ReleaseTarget): NamespacedCluster => ({
    kubectl: (args) => kubectl(target, args),
    apply: async (manifest) => { await infra.applyManifest(JSON.stringify(inNamespace(manifest, target.namespace)), await kubeconfigOf(target)); },
  });

  return {
    async OdooReleaseStateActivity(target: ReleaseTarget): Promise<SlotState> {
      try {
        const values = await infra.runHelm(['get', 'values', target.release, '-n', target.namespace, '-o', 'json'], await kubeconfigOf(target));
        return slotStateFrom(JSON.parse(values || 'null'));
      } catch (err) {
        if (notFound(err)) return NOTHING_INSTALLED;
        throw err;
      }
    },

    async OdooReleaseModulesActivity(source: ReleaseSource): Promise<string[]> {
      const repo = await gitea(infra);
      return modulesIn(await repo.listPaths(source.owner, source.repo, source.commit));
    },

    async OdooReleaseApplyActivity(input: { target: ReleaseTarget; source: ReleaseSource; sets: string[] }): Promise<void> {
      const repo = await gitea(infra);
      const paths = (await repo.listPaths(input.source.owner, input.source.repo, input.source.commit)).filter((file) => file.startsWith(`${CHART_DIR}/`));
      if (!paths.includes(`${CHART_DIR}/Chart.yaml`)) throw ApplicationFailure.nonRetryable(`${input.source.owner}/${input.source.repo} has no ${CHART_DIR}/Chart.yaml at ${input.source.commit}`);
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${input.target.release}-chart-`));
      const chart = path.join(dir, input.target.release);
      try {
        for (const file of paths) {
          const content = await repo.getRawFile(input.source.owner, input.source.repo, file, input.source.commit);
          if (content === null) continue;
          const local = path.join(chart, path.relative(CHART_DIR, file));
          await fs.mkdir(path.dirname(local), { recursive: true });
          await fs.writeFile(local, content);
        }
        await infra.applyManifest(JSON.stringify(releaseNamespace(input.target)), await kubeconfigOf(input.target));
        await infra.runHelmWithChart(
          (at) => ['upgrade', '--install', input.target.release, at, '-n', input.target.namespace, '--create-namespace', ...input.sets],
          chart,
          await kubeconfigOf(input.target),
        );
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },

    async OdooReleaseVaultActivity(input: { target: ReleaseTarget; vault: ReleaseVault }): Promise<void> {
      const kubeconfig = await kubeconfigOf(input.target);
      await infra.applyManifest(JSON.stringify(releaseNamespace(input.target)), kubeconfig);
      await syncVault({
        projectId: input.vault.projectId,
        namespace: input.target.namespace,
        secretName: input.vault.secret,
        kubeconfig,
        target: { clusterName: input.target.clusterName, provider: input.target.provider, isMock: isMockCloudProvider(input.target.provider as ClusterMetadata['provider'], hasCloudCredentials) },
      });
      const until = Date.now() + VAULT_WAIT_MS;
      let missing = input.vault.keys;
      while (Date.now() < until) {
        beat(missing);
        const data = await kubectl(input.target, ['get', 'secret', input.vault.secret, '-o', 'jsonpath={.data}']).catch(() => '');
        const present = new Set(Object.keys(data ? JSON.parse(data) as Record<string, string> : {}));
        missing = input.vault.keys.filter((key) => !present.has(key));
        if (missing.length === 0) return;
        await sleep(POLL_MS);
      }
      throw ApplicationFailure.nonRetryable(`the vault did not reach ${input.vault.secret} within ${VAULT_WAIT_MS / 60_000} minutes; still missing ${missing.join(', ')}`);
    },

    async OdooReleaseWaitActivity(input: { target: ReleaseTarget; workload: string; timeoutMs: number }): Promise<void> {
      const until = Date.now() + input.timeoutMs;
      let last = '';
      while (Date.now() < until) {
        beat(input.workload);
        try {
          await kubectl(input.target, ['rollout', 'status', input.workload, '--timeout=30s']);
          return;
        } catch (err) {
          last = (err as Error).message;
          await sleep(POLL_MS);
        }
      }
      throw ApplicationFailure.nonRetryable(`${input.workload} did not become ready in ${Math.round(input.timeoutMs / 60_000)} minutes: ${last.slice(-400)}`);
    },

    async OdooReleaseCopyDatabaseActivity(input: { target: ReleaseTarget; from: string; to: string }): Promise<void> {
      beat();
      await kubectl(input.target, ['exec', `${input.target.release}-postgres-0`, '--', 'sh', '-c', copyDatabaseScript(input.from, input.to)]);
    },

    async OdooReleaseInstalledActivity(input: { target: ReleaseTarget; database: string }): Promise<string[]> {
      const out = await kubectl(input.target, ['exec', `${input.target.release}-postgres-0`, '--', 'psql', '-U', 'odoo', '-d', input.database, '-tAc', "select name from ir_module_module where state = 'installed'"]).catch((err: Error) => {
        if (/does not exist/i.test(err.message)) return '';
        throw err;
      });
      return out.split('\n').map((line) => line.trim()).filter(Boolean).sort();
    },

    async OdooReleaseJobActivity(input: { target: ReleaseTarget; name: string; manifest: Record<string, unknown>; timeoutMs: number }): Promise<void> {
      await runClusterJob(namespaced(input.target), { name: input.name, namespace: input.target.namespace, manifest: input.manifest, timeoutMs: input.timeoutMs }, { beat });
    },

    async OdooReleaseQuietActivity(input: { target: ReleaseTarget; database: string }): Promise<void> {
      beat();
      await kubectl(input.target, ['exec', `${input.target.release}-postgres-0`, '--', 'psql', '-U', 'odoo', '-d', input.database, '-v', 'ON_ERROR_STOP=1', '-qc', QUIET_PREVIEW_SQL]);
    },

    async OdooReleaseScaleActivity(input: { target: ReleaseTarget; slot: Slot; replicas: number }): Promise<void> {
      await kubectl(input.target, ['scale', `deployment/${input.target.release}-odoo-${input.slot}`, `--replicas=${input.replicas}`]);
    },
  };
}

export type OdooReleaseActivities = ReturnType<typeof createOdooReleaseActivities>;
