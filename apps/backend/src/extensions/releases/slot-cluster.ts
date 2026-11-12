import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ApplicationFailure } from '@temporalio/common';
import type { ClusterAccess } from '../../infrastructure/index.js';
import { CHART_DIR, NOTHING_INSTALLED, slotStateFrom, type ReleaseVault, type SlotState } from '../../releases/lib/odoo-release.js';
import { clusterOfTarget } from '../../releases/lib/release-run.js';
import type { ReleaseSource, ReleaseTarget, VaultReach } from '../../releases/index.js';
import type { SecretSyncInfra } from '../../projects/index.js';
import { inNamespace, namespacedOn, runClusterJob, waitUntilRolledOut, type NamespacedCluster } from '../../activities/cluster-jobs.js';
import { labelValue } from '../../engine-host/sandboxes/workspace.js';
import { assessWorkload } from '../../infrastructure/lib/workload-health.js';
import { manifestList, registryPullManifests, type RegistryLogin, type RegistryLoginSource } from '../../instances/lib/registry-pull.js';

export interface VaultSyncArgs {
  projectId: string;
  namespace: string;
  secretName: string;
  kubeconfig: string;
  cluster: SecretSyncInfra;
  reach: VaultReach;
}

export type VaultSync = (args: VaultSyncArgs) => Promise<void>;

export interface RepoFiles {
  listPaths(owner: string, repo: string, commit: string): Promise<string[]>;
  getRawFile(owner: string, repo: string, file: string, commit: string): Promise<string | null>;
}

export interface SlotCluster {
  state(target: ReleaseTarget): Promise<SlotState>;
  files(source: ReleaseSource): Promise<string[]>;
  file(source: ReleaseSource, path: string): Promise<string | null>;
  apply(target: ReleaseTarget, source: ReleaseSource, sets: string[]): Promise<void>;
  vault(target: ReleaseTarget, vault: ReleaseVault): Promise<void>;
  waitReady(target: ReleaseTarget, workload: string): Promise<void>;
  exec(target: ReleaseTarget, pod: string, command: string[]): Promise<string>;
  job(target: ReleaseTarget, name: string, manifest: Record<string, unknown>): Promise<void>;
  scale(target: ReleaseTarget, workload: string, replicas: number): Promise<void>;
  put(target: ReleaseTarget, manifest: Record<string, unknown>): Promise<void>;
  remove(target: ReleaseTarget, kind: string, name: string, wait?: boolean): Promise<void>;
  running(target: ReleaseTarget, pod: string): Promise<void>;
  pipe(target: ReleaseTarget, pod: string, command: string[], input: NodeJS.ReadableStream): Promise<string>;
  pullAccess(target: ReleaseTarget): Promise<void>;
}

const POLL_MS = 5_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const notFound = (err: unknown): boolean => /not found|NotFound/i.test(String((err as Error)?.message ?? err));

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

export function preparedNamespace(target: Pick<ReleaseTarget, 'namespace' | 'owner'>, login: RegistryLogin): Record<string, unknown> {
  return manifestList([releaseNamespace(target), ...registryPullManifests(target.namespace, login)]);
}

export type SlotClusterAccess = Pick<ClusterAccess, 'kubectl' | 'helm' | 'apply' | 'pipe' | 'kubeconfigOf' | 'reach'>;

export function releaseCluster(target: ReleaseTarget): string {
  const found = clusterOfTarget(target);
  if ('problem' in found) throw ApplicationFailure.nonRetryable(found.problem);
  return found.clusterId;
}

export function createSlotCluster(deps: { access: SlotClusterAccess; repo: () => Promise<RepoFiles>; registry: RegistryLoginSource; syncVault: VaultSync; beat?: ((detail?: unknown) => void) | undefined }): SlotCluster {
  const { access } = deps;
  const beat = deps.beat ?? (() => {});
  const kubectl = async (target: ReleaseTarget, args: string[]) => access.kubectl(releaseCluster(target), ['-n', target.namespace, ...args]);
  const namespaced = (target: ReleaseTarget): NamespacedCluster => namespacedOn(access, releaseCluster(target), target.namespace);
  const absentAsNothing = (err: unknown): string => {
    if (/NotFound|not found/i.test((err as Error).message)) return '';
    throw err;
  };
  const prepare = async (target: ReleaseTarget): Promise<void> => {
    await access.apply(releaseCluster(target), JSON.stringify(preparedNamespace(target, await deps.registry())));
  };

  return {
    async state(target) {
      try {
        const values = await access.helm(releaseCluster(target), ['get', 'values', target.release, '-n', target.namespace, '-o', 'json']);
        return slotStateFrom(JSON.parse(values || 'null'));
      } catch (err) {
        if (notFound(err)) return NOTHING_INSTALLED;
        throw err;
      }
    },

    async files(source) {
      return (await deps.repo()).listPaths(source.owner, source.repo, source.commit);
    },

    async file(source, path) {
      return (await deps.repo()).getRawFile(source.owner, source.repo, path, source.commit);
    },

    async apply(target, source, sets) {
      const repo = await deps.repo();
      const paths = (await repo.listPaths(source.owner, source.repo, source.commit)).filter((file) => file.startsWith(`${CHART_DIR}/`));
      if (!paths.includes(`${CHART_DIR}/Chart.yaml`)) throw ApplicationFailure.nonRetryable(`${source.owner}/${source.repo} has no ${CHART_DIR}/Chart.yaml at ${source.commit}`);
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${target.release}-chart-`));
      const chart = path.join(dir, target.release);
      try {
        for (const file of paths) {
          const content = await repo.getRawFile(source.owner, source.repo, file, source.commit);
          if (content === null) continue;
          const local = path.join(chart, path.relative(CHART_DIR, file));
          await fs.mkdir(path.dirname(local), { recursive: true });
          await fs.writeFile(local, content);
        }
        await prepare(target);
        await access.helm(releaseCluster(target), ['upgrade', '--install', target.release, chart, '-n', target.namespace, '--create-namespace', ...sets]);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },

    async vault(target, vault) {
      const clusterId = releaseCluster(target);
      await prepare(target);
      const cluster: SecretSyncInfra = {
        runKubectl: (args) => access.kubectl(clusterId, args),
        runHelm: (args) => access.helm(clusterId, args),
        applyManifest: (manifest) => access.apply(clusterId, manifest),
      };
      await deps.syncVault({ projectId: vault.projectId, namespace: target.namespace, secretName: vault.secret, kubeconfig: await access.kubeconfigOf(clusterId), cluster, reach: await access.reach(clusterId) });
      let missing = vault.keys;
      for (;;) {
        beat(missing);
        const data = await kubectl(target, ['get', 'secret', vault.secret, '-o', 'jsonpath={.data}']).catch(absentAsNothing);
        const present = new Set(Object.keys(data ? JSON.parse(data) as Record<string, string> : {}));
        missing = vault.keys.filter((key) => !present.has(key));
        if (missing.length === 0) return;
        await sleep(POLL_MS);
      }
    },

    async waitReady(target, workload) {
      await waitUntilRolledOut(namespaced(target), workload, { beat, pollMs: POLL_MS });
    },

    async exec(target, pod, command) {
      beat();
      return kubectl(target, ['exec', pod, '--', ...command]);
    },

    async job(target, name, manifest) {
      await prepare(target);
      await runClusterJob(namespaced(target), { name, namespace: target.namespace, manifest }, { beat });
    },

    async scale(target, workload, replicas) {
      await kubectl(target, ['scale', workload, `--replicas=${replicas}`]);
    },

    async put(target, manifest) {
      await prepare(target);
      await access.apply(releaseCluster(target), JSON.stringify(inNamespace(manifest, target.namespace)));
    },

    async remove(target, kind, name, wait = false) {
      beat(name);
      await kubectl(target, ['delete', kind, name, '--ignore-not-found', `--wait=${wait}`, ...(kind === 'job' ? ['--cascade=foreground'] : [])]);
    },

    async running(target, pod) {
      for (;;) {
        beat(pod);
        const phase = await kubectl(target, ['get', 'pod', pod, '-o', 'jsonpath={.status.phase}']).catch(absentAsNothing);
        if (phase === 'Running') return;
        if (phase === 'Failed' || phase === 'Succeeded') throw ApplicationFailure.nonRetryable(`${pod} stopped (${phase}) before it could be used`);
        const listed = await kubectl(target, ['get', 'pod', pod, '-o', 'json']).catch(absentAsNothing);
        const health = listed ? assessWorkload({ items: [JSON.parse(listed)] }) : undefined;
        if (health?.health === 'unhealthy') throw ApplicationFailure.nonRetryable(`${pod} cannot run: ${health.reason}`);
        await sleep(POLL_MS);
      }
    },

    async pullAccess(target) {
      await prepare(target);
    },

    async pipe(target, pod, command, input) {
      return access.pipe(releaseCluster(target), ['-n', target.namespace, 'exec', '-i', pod, '--', ...command], input);
    },
  };
}
