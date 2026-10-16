import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ApplicationFailure } from '@temporalio/common';
import type { InfrastructureService } from '../../services/InfrastructureService.js';
import { CHART_DIR, NOTHING_INSTALLED, slotStateFrom, type ReleaseVault, type SlotState } from '../../lib/odoo-release.js';
import { reachCluster } from '../../activities/cluster-access.js';
import type { ReleaseSource, ReleaseTarget } from '../../lib/release-run.js';
import { inNamespace, runClusterJob, waitUntilRolledOut, type NamespacedCluster } from '../../activities/cluster-jobs.js';
import { labelValue } from '../../engine-host/sandboxes/workspace.js';
import { assessWorkload } from '../../lib/workload-health.js';
import type { SecretTarget } from '../../lib/infisical-sync.js';

export interface VaultSyncArgs {
  projectId: string;
  namespace: string;
  secretName: string;
  kubeconfig: string;
  target: SecretTarget;
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
  vault(target: ReleaseTarget, vault: ReleaseVault, secretTarget: SecretTarget): Promise<void>;
  waitReady(target: ReleaseTarget, workload: string): Promise<void>;
  exec(target: ReleaseTarget, pod: string, command: string[]): Promise<string>;
  job(target: ReleaseTarget, name: string, manifest: Record<string, unknown>): Promise<void>;
  scale(target: ReleaseTarget, workload: string, replicas: number): Promise<void>;
  put(target: ReleaseTarget, manifest: Record<string, unknown>): Promise<void>;
  remove(target: ReleaseTarget, kind: string, name: string, wait?: boolean): Promise<void>;
  running(target: ReleaseTarget, pod: string): Promise<void>;
  pipe(target: ReleaseTarget, pod: string, command: string[], input: NodeJS.ReadableStream): Promise<string>;
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

export function createSlotCluster(deps: { infra: InfrastructureService; repo: () => Promise<RepoFiles>; syncVault: VaultSync; beat?: ((detail?: unknown) => void) | undefined }): SlotCluster {
  const { infra } = deps;
  const beat = deps.beat ?? (() => {});
  const kubeconfigOf = (target: ReleaseTarget) => reachCluster(infra, target);
  const kubectl = async (target: ReleaseTarget, args: string[]) => infra.runKubectl(['-n', target.namespace, ...args], await kubeconfigOf(target));
  const namespaced = (target: ReleaseTarget): NamespacedCluster => ({
    kubectl: (args) => kubectl(target, args),
    apply: async (manifest) => { await infra.applyManifest(JSON.stringify(inNamespace(manifest, target.namespace)), await kubeconfigOf(target)); },
  });

  return {
    async state(target) {
      try {
        const values = await infra.runHelm(['get', 'values', target.release, '-n', target.namespace, '-o', 'json'], await kubeconfigOf(target));
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
        await infra.applyManifest(JSON.stringify(releaseNamespace(target)), await kubeconfigOf(target));
        await infra.runHelmWithChart(
          (at) => ['upgrade', '--install', target.release, at, '-n', target.namespace, '--create-namespace', ...sets],
          chart,
          await kubeconfigOf(target),
        );
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },

    async vault(target, vault, secretTarget) {
      const kubeconfig = await kubeconfigOf(target);
      await infra.applyManifest(JSON.stringify(releaseNamespace(target)), kubeconfig);
      await deps.syncVault({ projectId: vault.projectId, namespace: target.namespace, secretName: vault.secret, kubeconfig, target: secretTarget });
      let missing = vault.keys;
      for (;;) {
        beat(missing);
        const data = await kubectl(target, ['get', 'secret', vault.secret, '-o', 'jsonpath={.data}']).catch(() => '');
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
      await runClusterJob(namespaced(target), { name, namespace: target.namespace, manifest }, { beat });
    },

    async scale(target, workload, replicas) {
      await kubectl(target, ['scale', workload, `--replicas=${replicas}`]);
    },

    async put(target, manifest) {
      const kubeconfig = await kubeconfigOf(target);
      await infra.applyManifest(JSON.stringify(releaseNamespace(target)), kubeconfig);
      await infra.applyManifest(JSON.stringify(inNamespace(manifest, target.namespace)), kubeconfig);
    },

    async remove(target, kind, name, wait = false) {
      beat(name);
      await kubectl(target, ['delete', kind, name, '--ignore-not-found', `--wait=${wait}`]);
    },

    async running(target, pod) {
      for (;;) {
        beat(pod);
        const phase = await kubectl(target, ['get', 'pod', pod, '-o', 'jsonpath={.status.phase}']).catch(() => '');
        if (phase === 'Running') return;
        if (phase === 'Failed' || phase === 'Succeeded') throw ApplicationFailure.nonRetryable(`${pod} stopped (${phase}) before it could be used`);
        const listed = await kubectl(target, ['get', 'pod', pod, '-o', 'json']).catch(() => '');
        const health = listed ? assessWorkload({ items: [JSON.parse(listed)] }) : undefined;
        if (health?.health === 'unhealthy') throw ApplicationFailure.nonRetryable(`${pod} cannot run: ${health.reason}`);
        await sleep(POLL_MS);
      }
    },

    async pipe(target, pod, command, input) {
      return infra.pipeKubectl(['-n', target.namespace, 'exec', '-i', pod, '--', ...command], await kubeconfigOf(target), input);
    },
  };
}
