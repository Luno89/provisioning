import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { InfrastructureService } from '../services/InfrastructureService.js';
import { GiteaService } from '../services/GiteaService.js';
import { loadKeys } from '../lib/keys.js';
import { CHART_DIR, NOTHING_INSTALLED, copyDatabaseScript, modulesIn, slotStateFrom, type Slot, type SlotState } from '../lib/odoo-release.js';
import { reachCluster, type ClusterRef } from './cluster-access.js';
import { resolveKubeconfig } from './RunPipelineActivity.js';

export interface ReleaseTarget extends ClusterRef {
  namespace: string;
  release: string;
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

export function createOdooReleaseActivities(infra: InfrastructureService = new InfrastructureService()) {
  const kubeconfigOf = (target: ReleaseTarget) => reachCluster(infra, target);
  const kubectl = async (target: ReleaseTarget, args: string[]) => infra.runKubectl(['-n', target.namespace, ...args], await kubeconfigOf(target));

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
        await infra.runHelmWithChart(
          (at) => ['upgrade', '--install', input.target.release, at, '-n', input.target.namespace, '--create-namespace', ...input.sets],
          chart,
          await kubeconfigOf(input.target),
        );
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
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
      await kubectl(input.target, ['delete', 'job', input.name, '--ignore-not-found', '--wait=true']);
      const manifest = { ...input.manifest, metadata: { ...(input.manifest.metadata as object), name: input.name, namespace: input.target.namespace } };
      await infra.applyManifest(JSON.stringify(manifest), await kubeconfigOf(input.target));
      const until = Date.now() + input.timeoutMs;
      while (Date.now() < until) {
        beat(input.name);
        const status = await kubectl(input.target, ['get', 'job', input.name, '-o', 'jsonpath={.status.succeeded}|{.status.failed}']);
        const [succeeded, failed] = status.split('|').map((value) => Number(value) || 0);
        if (succeeded) return;
        if (failed) {
          const logs = await kubectl(input.target, ['logs', `job/${input.name}`, '--tail=30']).catch(() => '');
          const said = logs.split('\n').filter((line) => /ERROR|CRITICAL|Traceback|Error/.test(line)).slice(-6).join('\n') || logs.split('\n').slice(-8).join('\n');
          throw ApplicationFailure.nonRetryable(`${input.name} failed:\n${said.slice(-1500)}`);
        }
        await sleep(POLL_MS);
      }
      throw ApplicationFailure.nonRetryable(`${input.name} did not finish in ${Math.round(input.timeoutMs / 60_000)} minutes`);
    },

    async OdooReleaseScaleActivity(input: { target: ReleaseTarget; slot: Slot; replicas: number }): Promise<void> {
      await kubectl(input.target, ['scale', `deployment/${input.target.release}-odoo-${input.slot}`, `--replicas=${input.replicas}`]);
    },
  };
}

export type OdooReleaseActivities = ReturnType<typeof createOdooReleaseActivities>;
