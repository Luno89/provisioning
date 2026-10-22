import { assessWorkload, type InfrastructureService } from '../infrastructure/index.js';
import { randomBytes } from 'crypto';
import { Context } from '@temporalio/activity';
import { CancelledFailure } from '@temporalio/common';
import { readFailureArtifacts, readWhole, type KeepArtifacts, type WorkspaceExec } from '../files/lib/artifacts.js';
import { E2E_REPORT, e2ePassed, plain, readE2EReport } from '../engine/index.js';
import {
  databaseOf, databaseSecretFrom, releaseTargetOf, vaultDatabaseSecret, type Slot, E2E_DONE, E2E_INSTALL_FAILED,
  E2E_WORKDIR, MAX_SPEC_BYTES, browserTestsJob, loginSecret, releaseE2EFrom, releaseE2EName, releaseLoginJobName,
  releaseLoginSecret, releaseSpecFiles, specBytes, specConfigMap, testLoginJob, withConfig, type ReleaseE2E,
  type ReleaseSource, type ReleaseTarget,
} from '../releases/index.js';
import type { ClusterMetadata, ProjectMetadata } from '../platform/index.js';
import { reachCluster } from './cluster-access.js';
import { manifestList, registryPullManifests, type RegistryLoginSource } from '../instances/lib/registry-pull.js';
import { inNamespace, runClusterJob, type NamespacedCluster } from './cluster-jobs.js';

const vaultKeys = (data: string): string[] => {
  try {
    return Object.keys(JSON.parse(data) as Record<string, string>);
  } catch {
    return [];
  }
};

export interface ReleaseBrowserTestsInput {
  target: ReleaseTarget;
  source: ReleaseSource;
  ownerId: string;
  releaseId: string;
  slot: Slot;
  image: string;
}

export interface BrowserTestRun {
  target: ReleaseTarget;
  ownerId: string;
  keepUnder: string;
  slot: Slot;
  image: string;
  files: { path: string; content: string }[];
}

export interface SpecSource {
  listPaths(owner: string, name: string, ref: string): Promise<string[]>;
  getRawFile(owner: string, name: string, filePath: string, ref?: string): Promise<string | null>;
}

export interface ReleaseBrowserTestDeps {
  cluster: (target: ReleaseTarget) => NamespacedCluster;
  specs: () => Promise<SpecSource>;
  keep?: KeepArtifacts | undefined;
  password?: (() => string) | undefined;
  now?: (() => string) | undefined;
  pollMs?: number | undefined;
  beat?: ((detail?: unknown) => void) | undefined;
  cancelled?: (() => boolean) | undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const notFound = (err: unknown): boolean => /not found|NotFound/i.test(String((err as Error)?.message ?? err));

const activityBeat = (detail?: unknown) => { try { Context.current().heartbeat(detail); } catch { return; } };
const activityCancelled = (): boolean => { try { return Context.current().cancellationSignal.aborted; } catch { return false; } };

export function namespacedCluster(infra: InfrastructureService, registry: RegistryLoginSource): (target: ReleaseTarget) => NamespacedCluster {
  return (target) => {
    let pulling: Promise<void> | undefined;
    const pullAccess = (kubeconfig: string): Promise<void> => {
      pulling ??= (async () => {
        await infra.applyManifest(JSON.stringify(manifestList(registryPullManifests(target.namespace, await registry()))), kubeconfig);
      })().catch((err: unknown) => {
        pulling = undefined;
        throw err;
      });
      return pulling;
    };
    return {
      kubectl: async (args) => infra.runKubectl(['-n', target.namespace, ...args], await reachCluster(infra, target)),
      apply: async (manifest) => {
        const kubeconfig = await reachCluster(infra, target);
        await pullAccess(kubeconfig);
        await infra.applyManifest(JSON.stringify(inNamespace(manifest, target.namespace)), kubeconfig);
      },
    };
  };
}

function podExec(cluster: NamespacedCluster, pod: string): WorkspaceExec {
  return {
    async exec(command) {
      try {
        const stdout = await cluster.kubectl(['exec', pod, '-c', 'playwright', '--', 'sh', '-c', `cd ${E2E_WORKDIR} && ${command}`]);
        return { stdout, stderr: '', exitCode: 0 };
      } catch (err) {
        return { stdout: '', stderr: (err as Error).message, exitCode: 1 };
      }
    },
  };
}

export function createReleaseBrowserTestActivities(deps: ReleaseBrowserTestDeps) {
  const now = deps.now ?? (() => new Date().toISOString());
  const beat = deps.beat ?? activityBeat;
  const stopped = () => {
    if ((deps.cancelled ?? activityCancelled)()) throw new CancelledFailure('the browser tests were stopped');
  };

  async function ensureLogin(cluster: NamespacedCluster, release: string): Promise<void> {
    try {
      await cluster.kubectl(['get', 'secret', releaseLoginSecret(release), '-o', 'name']);
    } catch (err) {
      if (!notFound(err)) throw err;
      await cluster.apply(loginSecret(release, (deps.password ?? (() => randomBytes(24).toString('base64url')))()));
    }
  }

  async function waitForDone(cluster: NamespacedCluster, name: string): Promise<{ pod: string; done: string } | { problem: string }> {
    let pod = '';
    for (;;) {
      beat(name);
      stopped();
      const seen = await cluster.kubectl(['get', 'pod', '-l', `job-name=${name}`, '-o', 'json']).catch(() => '');
      const pods = seen ? JSON.parse(seen) as { items?: { metadata?: { name?: string }; status?: { phase?: string } }[] } : { items: [] };
      const first = pods.items?.[0];
      const phase = first?.status?.phase ?? '';
      pod = first?.metadata?.name || pod;
      const health = assessWorkload(pods);
      if (health.health === 'unhealthy') return { problem: `the browser's pod cannot run: ${health.reason}` };
      if (phase === 'Failed' || phase === 'Succeeded') {
        const logs = await cluster.kubectl(['logs', pod, '-c', 'playwright', '--tail=20']).catch(() => '');
        return { problem: `the browser's pod ended before the tests finished${logs ? `:\n${plain(logs).slice(-1200)}` : ''}` };
      }
      if (pod && phase === 'Running') {
        const done = await podExec(cluster, pod).exec(`cat ${E2E_DONE} 2>/dev/null`);
        if (done.exitCode === 0 && done.stdout.trim()) return { pod, done: done.stdout.trim() };
      }
      await sleep(deps.pollMs ?? 5_000);
    }
  }

  async function reportOf(exec: WorkspaceExec): Promise<string | undefined> {
    const size = await exec.exec(`wc -c < ${E2E_REPORT}`);
    if (size.exitCode !== 0 || !/^\d+$/.test(size.stdout.trim())) return undefined;
    const bytes = await readWhole(exec, E2E_REPORT, Number(size.stdout.trim()));
    return bytes?.toString('utf8');
  }

  async function readSpecs(source: ReleaseSource): Promise<{ files: { path: string; content: string }[] } | { reason: string }> {
    const { owner, repo: name, commit } = source;
    const specs = await deps.specs();
    const listed = releaseSpecFiles(await specs.listPaths(owner, name, commit));
    if (listed.specs.length === 0) return { reason: `there are no browser tests in e2e/ at ${commit.slice(0, 8)}` };
    const read = await Promise.all(listed.files.map(async (path) => ({ path, content: await specs.getRawFile(owner, name, path, commit) })));
    return { files: withConfig(read.filter((file): file is { path: string; content: string } => file.content !== null)) };
  }

  async function runBrowserTests(input: BrowserTestRun): Promise<ReleaseE2E> {
    const startedAt = now();
    const unavailable = (reason: string): ReleaseE2E => ({ state: 'unavailable', reason, startedAt, finishedAt: now() });
    const { files } = input;
    if (specBytes(files) > MAX_SPEC_BYTES) return unavailable(`the browser tests in e2e/ come to more than ${Math.round(MAX_SPEC_BYTES / 1024)} KB, more than a run can be handed`);

    const cluster = deps.cluster(input.target);
    const { release, namespace } = input.target;
    const jobName = releaseE2EName(release);
    try {
      await ensureLogin(cluster, release);
      const vaulted = await cluster.kubectl(['get', 'secret', vaultDatabaseSecret(release).secret, '-o', 'jsonpath={.data}', '--ignore-not-found']).catch(() => '');
      const password = databaseSecretFrom(vaultKeys(vaulted), release);
      try {
        await runClusterJob(cluster, {
          name: releaseLoginJobName(release, input.slot),
          namespace,
          manifest: testLoginJob({ release, slot: input.slot, image: input.image, database: databaseOf(input.slot), password }),
        }, { beat, stopped, pollMs: deps.pollMs });
      } catch (err) {
        if (err instanceof CancelledFailure) throw err;
        return unavailable(`the test login could not be set up in slot ${input.slot}: ${(err as Error).message}`);
      }

      await cluster.kubectl(['delete', 'job', jobName, '--ignore-not-found', '--wait=true']);
      const map = specConfigMap(release, files);
      await cluster.apply({ ...map.manifest, metadata: { ...(map.manifest.metadata as object), namespace } });
      const job = browserTestsJob({ release, slot: input.slot, items: map.items });
      await cluster.apply({ ...job, metadata: { ...(job.metadata as object), namespace } });

      const finished = await waitForDone(cluster, jobName);
      if ('problem' in finished) return unavailable(finished.problem);
      const exec = podExec(cluster, finished.pod);
      if (finished.done === E2E_INSTALL_FAILED) {
        const npm = await exec.exec('tail -n 20 npm.log');
        return unavailable(`Playwright could not be installed in the browser's pod${npm.stdout ? `:\n${plain(npm.stdout)}` : ''}`);
      }

      const exit = Number(finished.done);
      const report = readE2EReport(await reportOf(exec));
      const printed = plain((await exec.exec('tail -n 30 run.log')).stdout).slice(-1500);
      const passing = report !== undefined && exit === 0 && e2ePassed(report);
      let artifacts: { id: string; name: string }[] = [];
      let notKept: string[] = [];
      if (!passing && deps.keep) {
        beat('keeping what the browser saw');
        const left = await readFailureArtifacts(exec);
        const kept = left.files.length > 0 ? await deps.keep(input.ownerId, input.keepUnder, left.files) : { stored: [], dropped: [] };
        artifacts = kept.stored.map((artifact) => ({ id: artifact.id, name: artifact.name }));
        notKept = [...left.dropped, ...kept.dropped, ...left.unreadable];
      }
      return releaseE2EFrom({ report, exit: Number.isFinite(exit) ? exit : 1, printed, artifacts, notKept, startedAt, finishedAt: now() });
    } finally {
      await cluster.kubectl(['delete', 'job', jobName, '--ignore-not-found', '--wait=false']).catch(() => undefined);
      await cluster.kubectl(['delete', 'configmap', jobName, '--ignore-not-found']).catch(() => undefined);
    }
  }

  return {
    runBrowserTests,
    readSpecs,
    async ReleaseBrowserTestsActivity(input: ReleaseBrowserTestsInput): Promise<ReleaseE2E> {
      const startedAt = now();
      const specs = await readSpecs(input.source);
      if ('reason' in specs) return { state: 'unavailable', reason: specs.reason, startedAt, finishedAt: now() };
      return runBrowserTests({ target: input.target, ownerId: input.ownerId, keepUnder: input.releaseId, slot: input.slot, image: input.image, files: specs.files });
    },
  };
}

export type ReleaseBrowserTestActivities = Pick<ReturnType<typeof createReleaseBrowserTestActivities>, 'ReleaseBrowserTestsActivity'>;
export type ReleaseBrowserTests = ReturnType<typeof createReleaseBrowserTestActivities>;

export interface CheckReleaseDeps {
  browser: Pick<ReleaseBrowserTests, 'runBrowserTests' | 'readSpecs'>;
  cluster: (target: ReleaseTarget) => NamespacedCluster;
  project: (id: string) => Promise<Pick<ProjectMetadata, 'id' | 'name' | 'releaseName' | 'ownerId' | 'targetClusterId' | 'giteaOwner' | 'giteaRepo'> | undefined>;
  clusterById: (id: string) => Promise<ClusterMetadata | undefined>;
}

export function createCheckReleases(deps: CheckReleaseDeps) {
  const placeOf = async (ownerId: string, projectId: string): Promise<{ target: ReleaseTarget; project: NonNullable<Awaited<ReturnType<CheckReleaseDeps['project']>>> }> => {
    const project = await deps.project(projectId);
    if (!project || project.ownerId !== ownerId) throw new Error('the check has no such project');
    const cluster = project.targetClusterId ? await deps.clusterById(project.targetClusterId) : undefined;
    if (!cluster) throw new Error(`the project ${project.name} has no cluster to release on`);
    return { target: releaseTargetOf(cluster, project), project };
  };
  const seenAt = async (at: { clusterId: string; namespace: string }): Promise<ReleaseTarget> => {
    const cluster = await deps.clusterById(at.clusterId);
    if (!cluster) throw new Error(`the cluster ${at.clusterId} the app ran on is gone`);
    return releaseTargetOf(cluster, { id: '', name: at.namespace, releaseName: at.namespace });
  };
  return {
    async browse(args: { ownerId: string; projectId: string; release: { slot: Slot; image: string; commit: string }; specs?: Record<string, string> | undefined; keepUnder: string }): Promise<ReleaseE2E> {
      const { target, project } = await placeOf(args.ownerId, args.projectId);
      const startedAt = new Date().toISOString();
      let files: { path: string; content: string }[];
      if (args.specs) files = withConfig(Object.entries(args.specs).map(([path, content]) => ({ path, content })));
      else {
        if (!project.giteaOwner || !project.giteaRepo) return { state: 'unavailable', reason: 'the project has no repository to read browser tests from', startedAt, finishedAt: new Date().toISOString() };
        const read = await deps.browser.readSpecs({ owner: project.giteaOwner, repo: project.giteaRepo, commit: args.release.commit });
        if ('reason' in read) return { state: 'unavailable', reason: read.reason, startedAt, finishedAt: new Date().toISOString() };
        files = read.files;
      }
      return deps.browser.runBrowserTests({ target, ownerId: args.ownerId, keepUnder: args.keepUnder, slot: args.release.slot, image: args.release.image, files });
    },
    async namespaceExists(args: { ownerId: string; projectId: string; at?: { clusterId: string; namespace: string } | undefined }): Promise<boolean> {
      const target = args.at ? await seenAt(args.at) : (await placeOf(args.ownerId, args.projectId)).target;
      const found = await deps.cluster(target).kubectl(['get', 'namespace', target.namespace, '-o', 'name', '--ignore-not-found']);
      return found.trim() !== '';
    },
  };
}
