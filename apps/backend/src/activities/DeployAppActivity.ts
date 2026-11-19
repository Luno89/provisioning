import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { ApplicationFailure } from '@temporalio/common';
import {
  renderApp, specSecrets, minioStorageFor, specStorageFor, visibleAppSpecs, resolveBindings, bindingFiles, bindingProjection, bindingSecretName,
  type ProjectedBinding, StorageAdapter, buildAppEnv, envSettingsOf, modelHfToken, TABBYAPI_DEFAULT_MAX_SEQ_LEN, planHostMemory,
  parseQuantity, type HostMemoryPlan, appStackName, NO_STACK_ID, gitappPullSecretArgs, type MachineOfCluster, type Provisioner, type Reach, unsizedModel } from '../infrastructure/index.js';
import type { ProvisionTarget } from '@koala/engine-core/koala-install';
import { readBindingCredentials, sanitiseNamespaceName, syncProjectSecrets } from '../projects/index.js';
import { createDatabase, failureOf, type AppSettings } from '../platform/index.js';

import { monitoringMissing } from './cluster-monitoring.js';
import { applyWatched } from './watched-apply.js';
import type { ClusterSteps } from './cluster-steps.js';
import { handedReach } from './handed-reach.js';
import { appServiceType, placedOnPool } from '../infrastructure/index.js';
import { infisicalHostFor } from '../releases/index.js';
import { ignore } from '@koala/engine-core/failures';

async function nodeAllocatableBytes(kubectl: (args: string[]) => Promise<string>): Promise<number> {
  const memories = await kubectl(['get', 'nodes', '-o', 'jsonpath={.items[*].status.allocatable.memory}']);
  const sizes = memories.trim().split(/\s+/)
    .map((q: string) => parseQuantity(q))
    .filter((n): n is number => n !== undefined);
  if (sizes.length === 0) throw new Error(`the machine's nodes report no memory Koala can read (${JSON.stringify(memories.trim())})`);
  return Math.min(...sizes);
}

function setupTarget(args: DeployAppArgs, reach: Reach): ProvisionTarget {
  if (reach.kind === 'koala') return { kind: 'koala', clusterId: reach.clusterId };
  if (reach.kind === 'machine' && args.machine) return { kind: 'machine', clusterId: args.clusterId, machine: args.clusterName, deviceId: args.machine.deviceId };
  throw ApplicationFailure.nonRetryable(`${args.name} goes on ${args.clusterName}, which Koala sets up no monitoring for, and no app goes on a cluster without it`, 'NoMonitoringSetup');
}

export interface DeploySteps extends ClusterSteps {
  provisioner: Provisioner;
}

async function monitoredFirst(args: DeployAppArgs, reach: Reach, steps: DeploySteps, logFile: string): Promise<void> {
  const pool = placedOnPool(Boolean(steps.access.here.poolName), reach);
  if (!(await monitoringMissing(steps, { reach, pool, machine: reach.kind === 'machine' }))) return;
  const target = setupTarget(args, reach);
  await fs.appendFile(logFile, `[deploy] waiting for Koala to set up its monitoring of ${args.clusterName} before ${args.name} goes on it\n`).catch(ignore('the log only shows progress, and the deploy waits on the setup either way'));
  const run = await steps.provisioner.ensure(target, 'missing');
  const settled = await steps.provisioner.settled(run.id);
  if (settled.state === 'failed') {
    throw ApplicationFailure.nonRetryable(`Koala could not set up the monitoring of ${args.clusterName}, which ${args.name} needs before it goes on: ${settled.why}`, 'MonitoringNotSetUp');
  }
}

export interface DeployAppArgs extends AppSettings {
  name: string;
  machine?: MachineOfCluster | undefined;
  reach?: Reach | undefined;
  kubeconfig?: string | undefined;
  namespace?: string | undefined;
  clusterId: string;
  clusterName: string;
  strategy: string;
  appType: string;
  modules?: string[] | undefined;
  odooRepo: string;
  odooTag: string;
  dbRepo: string;
  dbTag: string;
  logFile: string;
  deploymentId?: string | undefined;
  modelCacheHostPath?: string | undefined;
  modelImage?: string | undefined;
  modelPreDownloaded?: boolean | undefined;
  openaiApiBaseUrl?: string | undefined;
}

export interface DeployAppResult {
  status: string;
  msg: string;
  displayUrl: string;
  notes: string[];
}

const SANITIZE = sanitiseNamespaceName;

export async function DeployAppActivity(args: DeployAppArgs, steps: DeploySteps, signal?: AbortSignal): Promise<DeployAppResult> {
  const { access } = steps;
  if (args.modules && args.modules.length > 0) {
    throw ApplicationFailure.nonRetryable(`${args.name} names Odoo modules to build into its image, and that image would be built in this computer's Docker, where no cluster Koala reaches pulls from; release the modules through the project's repository instead`, 'ModulesImageUnreachable');
  }
  const reach = handedReach(args);
  const kubectl = (argv: string[]) => access.kubectl(reach, argv);
  const logFile = args.logFile;
  const namespace = args.namespace ?? SANITIZE(args.name);

  const DEFAULT_APP_REPOS: Record<string, { repo: string; tag: string }> = {
    odoo: { repo: 'library/odoo', tag: 'latest' },
    wordpress: { repo: 'library/wordpress', tag: 'latest' },
    nextcloud: { repo: 'library/nextcloud', tag: 'latest' },
    audiobookshelf: { repo: 'ghcr.io/advplyr/audiobookshelf', tag: 'latest' },
    jellyfin: { repo: 'jellyfin/jellyfin', tag: 'latest' },
    plex: { repo: 'plexinc/pms-docker', tag: 'latest' },
    navidrome: { repo: 'deluan/navidrome', tag: 'latest' },
    kavita: { repo: 'jvmorgan/kavita', tag: 'latest' },
    immich: { repo: 'ghcr.io/immich-app/immich-server', tag: 'release' },
    papra: { repo: 'papra/papra', tag: 'latest' },
    homeassistant: { repo: 'ghcr.io/home-assistant/home-assistant', tag: 'stable' },
    vllm: { repo: 'vllm/vllm-openai', tag: 'latest' },
    openwebui: { repo: 'ghcr.io/open-webui/open-webui', tag: 'main' },
    hermes: { repo: 'nousresearch/hermes-agent', tag: 'latest' },
    palworld: { repo: 'thijsvanloef/palworld-server-docker', tag: 'latest' },
    minio: { repo: 'pgsty/minio', tag: 'RELEASE.2026-03-14T12-00-00Z' },
    qdrant: { repo: 'qdrant/qdrant', tag: 'latest' },
    quickwit: { repo: 'quickwit/quickwit', tag: 'latest' },
    tei: { repo: 'ghcr.io/huggingface/text-embeddings-inference', tag: 'cpu-latest' },
    verdaccio: { repo: 'verdaccio/verdaccio', tag: 'latest' },
  };

  const appDefault = DEFAULT_APP_REPOS[args.appType] || { repo: '', tag: 'latest' };
  const sentOdooFallback = args.appType !== 'odoo' && args.odooRepo === 'library/odoo';
  const finalOdooRepo = sentOdooFallback ? appDefault.repo : (args.odooRepo || appDefault.repo);
  const finalOdooTag = sentOdooFallback ? appDefault.tag : (args.odooTag || appDefault.tag);

  const physicalName = args.clusterName;
  const kubeconfigPath = await access.kubeconfigOf(reach);

  const notes: string[] = [];
  const note = async (line: string) => {
    notes.push(line);
    await fs.appendFile(logFile, `[deploy] ${line}\n`).catch(ignore('the note is also kept on the app, and the log only shows progress'));
  };

  if (args.appType === 'palworld') {
    const REQUIRED_GI = 12;
    let memories: string | undefined;
    try {
      memories = await kubectl(['get', 'nodes', '-o', 'jsonpath={.items[*].status.allocatable.memory}']);
    } catch (err) {
      const failure = failureOf(err);
      if (failure.kind === 'final') throw ApplicationFailure.nonRetryable(`the machine's memory could not be read: ${failure.reason}`);
      await note(`Whether Palworld fits in the machine's memory was not checked: the machine's memory could not be read (${failure.reason}).`);
    }
    if (memories !== undefined) {
      const toGi = (q: string): number => {
        const m = /^(\d+)(Ki|Mi|Gi)?$/.exec(q ?? '');
        if (!m?.[1]) return 0;
        const n = Number(m[1]);
        return m[2] === 'Gi' ? n : m[2] === 'Mi' ? n / 1024 : n / (1024 * 1024);
      };
      const largest = Math.max(0, ...memories.trim().split(/\s+/).filter(Boolean).map((memory) => toGi(memory)));
      if (largest === 0) throw ApplicationFailure.nonRetryable(`the machine's nodes report no memory Koala can read (${JSON.stringify(memories.trim())})`);
      if (largest < REQUIRED_GI) {
        throw ApplicationFailure.nonRetryable(
          `Palworld needs a node with at least ${REQUIRED_GI}Gi allocatable memory; the largest node in this `
          + `cluster has ${largest.toFixed(1)}Gi. Deploy to a machine with more memory.`,
        );
      }
    }
  }

  const storageEnv = StorageAdapter.getStorageEnv(args.appType, args.strategy, {});
  const displayUrl = args.appType === 'palworld'
    ? ''
    : args.appType === 'odoo'
    ? 'http://localhost:8069'
    : args.appType === 'vllm'
    ? 'http://localhost:8000'
    : args.appType === 'tabbyapi'
    ? 'http://localhost:5000'
    : args.appType === 'openwebui'
    ? 'http://localhost:8080'
    : args.appType === 'hermes'
    ? 'http://localhost:9119'
    : args.appType === 'gitapp'
    ? 'http://localhost:8080'
    : 'http://localhost:80';

  if (!args.deploymentId) throw ApplicationFailure.nonRetryable(`${args.name} ${NO_STACK_ID}`);
  const deploymentId = args.deploymentId;

  let tabbyModelSizeBytes: number | undefined;
  if (args.appType === 'tabbyapi' && !args.tabbyModel) throw ApplicationFailure.nonRetryable('TabbyAPI was given no model to serve');
  if (args.appType === 'tabbyapi' && args.tabbyModel) {
    try {
      const { getHfModelSize } = await import('../infrastructure/index.js');
      const size = await getHfModelSize(args.tabbyModel, args.tabbyRevision, args.tabbyHfToken);
      tabbyModelSizeBytes = size.totalBytes;
    } catch (err) {
      const failure = failureOf(err);
      if (failure.kind === 'final') throw ApplicationFailure.nonRetryable(`Hugging Face could not say how big ${args.tabbyModel} is: ${failure.reason}`);
      if (!args.tabbyMemoryLimit || !args.tabbyShmSize) throw ApplicationFailure.nonRetryable(unsizedModel(args.tabbyModel, failure.reason));
      await note(`Memory is the ${args.tabbyMemoryLimit} and ${args.tabbyShmSize} of shared memory you set: Hugging Face could not say how big ${args.tabbyModel} is (${failure.reason}).`);
    }
  }

  let tabbyMemoryPlan: HostMemoryPlan | undefined;
  if (args.appType === 'tabbyapi' && tabbyModelSizeBytes !== undefined) {
    let allocatableBytes: number | undefined;
    try {
      allocatableBytes = await nodeAllocatableBytes(kubectl);
    } catch (err) {
      const failure = failureOf(err);
      if (failure.kind === 'final') throw ApplicationFailure.nonRetryable(`the machine's memory could not be read: ${failure.reason}`);
      await note(`Whether the model fits in the machine's memory was not checked: the machine's memory could not be read (${failure.reason}).`);
    }
    if (!args.tabbyGpuCount || args.tabbyGpuCount < 1) throw ApplicationFailure.nonRetryable('TabbyAPI was not told how many GPUs it uses: deploy it again with 1 or more. Koala runs no model on CPU.');
    tabbyMemoryPlan = planHostMemory({
      modelBytes: tabbyModelSizeBytes,
      gpuCount: args.tabbyGpuCount,
      maxSeqLen: args.tabbyMaxSeqLen ?? TABBYAPI_DEFAULT_MAX_SEQ_LEN,
      inlineModelLoading: args.tabbyInlineModelLoading === true,
      allocatableBytes,
    });
    if (tabbyMemoryPlan.refusal) throw new Error(tabbyMemoryPlan.refusal);
    console.log(`[DeployAppActivity] host memory plan: ${tabbyMemoryPlan.basis}`);

    const chosen = args.tabbyMemoryLimit ? parseQuantity(args.tabbyMemoryLimit) : undefined;
    if (chosen !== undefined && chosen < tabbyMemoryPlan.limitBytes) {
      console.warn(
        `[DeployAppActivity] memory limit set to ${args.tabbyMemoryLimit}, below the estimated `
        + `${Math.ceil(tabbyMemoryPlan.limitBytes / 1e9)}G — the pod may be OOMKilled under load. `
        + `Basis: ${tabbyMemoryPlan.basis}`,
      );
    }
  }

  let renderedSpec: unknown;
  {
    const specDb = createDatabase(steps.database);
    await specDb.init();
    const stored = (await specDb.infrastructure.getAppSpecs()).find((s) => s.id === args.appType)
      ?? undefined;
    await specDb.close().catch(ignore('the specs were already read, and a connection that does not close cleanly holds nothing this deploy needs'));
    if (stored?.spec) {
      const secrets = specSecrets(args.appType, stored.spec, {
        crawl4aiApiToken: args.crawl4aiApiToken,
        searxngSecretKey: args.searxngSecretKey,
        qdrantApiKey: args.qdrantApiKey,
        minioRootUser: args.minioRootUser,
        minioRootPassword: args.minioRootPassword,
      }, (kind) => (kind === 'username' ? 'koala' : randomBytes(24).toString('hex')));
      const storage = specStorageFor(args.appType, placedOnPool(Boolean(access.here.poolName), reach), args);
      renderedSpec = renderApp(stored.spec, {
        id: deploymentId,
        namespace: namespace,
        serviceType: appServiceType(placedOnPool(Boolean(access.here.poolName), reach)),
        secrets,
        ...(storage ? { storage } : {}),
      });
      console.log(`[DeployAppActivity] ${args.appType} deploying from a stored spec, not a construct`);
    }
  }

  let bindingsJson = '';
  {
    const bindDb = createDatabase(steps.database);
    await bindDb.init();
    const deployments = await bindDb.infrastructure.getDeployments();
    const self = deployments.find((d) => d.name === args.name || d.id === args.name);
    const project = self?.gitappProjectId
      ? (await bindDb.projects.getProjects()).find((p) => p.id === self.gitappProjectId)
      : undefined;
    const needs = project?.needs ?? [];
    const specs = needs.length && project?.ownerId
      ? visibleAppSpecs(await bindDb.infrastructure.getAppSpecs(), project.ownerId)
      : [];
    const dynamicTypes = needs.length ? await bindDb.infrastructure.getBindingTypes() : [];
    await bindDb.close().catch(ignore('the bindings were already read, and a connection that does not close cleanly holds nothing this deploy needs'));

    if (needs.length && project?.ownerId) {
      const { bindings, problems } = resolveBindings(needs, deployments, specs, project.ownerId, { dynamicTypes });
      if (problems.length > 0) throw ApplicationFailure.nonRetryable(`${args.name} cannot be given what it depends on: ${problems.join('; ')}`);

      const projected: ProjectedBinding[] = [];
      for (const b of bindings) {
        const credentials = await readBindingCredentials(kubectl, b);

        const secretName = bindingSecretName(b.name);
        const files = bindingFiles(b, credentials);
        const manifest = JSON.stringify({
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: { name: secretName, namespace: namespace },
          type: 'Opaque',
          stringData: files,
        });
        await access.apply(reach, manifest);
        projected.push({ name: b.name, secretName });
        console.log(`[bindings] ${physicalName}: bound ${b.name} (${b.type}) from ${b.source.namespace}`);
      }
      if (projected.length) bindingsJson = JSON.stringify(bindingProjection(projected));
    }
  }

  const onPool = placedOnPool(Boolean(access.here.poolName), reach);
  const tabbyMemoryLimit = args.tabbyMemoryLimit || (tabbyMemoryPlan ? `${Math.ceil(tabbyMemoryPlan.limitBytes / 1e9)}G` : undefined);
  const tabbyShmSize = args.tabbyShmSize || (tabbyMemoryPlan ? `${Math.ceil(tabbyMemoryPlan.shmBytes / 1024 ** 3)}Gi` : undefined);
  const minioStorage = minioStorageFor(onPool, args.minioStorage);
  const env = buildAppEnv({
    ...envSettingsOf(args),
    ...(tabbyMemoryLimit ? { tabbyMemoryLimit } : {}),
    ...(tabbyShmSize ? { tabbyShmSize } : {}),
    ...(minioStorage ? { minioStorage } : {}),
    hfToken: modelHfToken(args),
    modelPreDownloaded: args.modelPreDownloaded === true,
    modelImage: args.modelImage,
    serviceType: appServiceType(onPool),
    ...(renderedSpec ? { renderedSpec } : {}),
    ...(bindingsJson ? { bindingsJson } : {}),
    physicalName,
    strategy: args.strategy,
    namespace,
    deploymentId,
    kubeconfigPath,
    appType: args.appType,
    webRepo: finalOdooRepo,
    webTag: finalOdooTag,
    dbRepo: args.dbRepo,
    dbTag: args.dbTag,
    tabbyModelSizeBytes,
    openaiApiBaseUrl: args.openaiApiBaseUrl,
    storageEnv,
  });

  await monitoredFirst(args, reach, steps, logFile);
  await applyWatched(steps, appStackName(physicalName, deploymentId), { logFile, env }, { what: args.name, reach, namespaces: [namespace], signal });

  if (args.appType === 'gitapp') {
    const { gitea } = steps;
    const registryHost = await gitea.getRegistryHost();
    const pull = await gitea.registryLogin();
    await access.apply(reach, await kubectl(gitappPullSecretArgs(namespace, registryHost, pull)));

    const secretDb = createDatabase(steps.database);
    await secretDb.init();
    try {
      const self = (await secretDb.infrastructure.getDeployments()).find((d) => d.name === args.name || d.id === args.name);
      const project = self?.gitappProjectId
        ? (await secretDb.projects.getProjects()).find((p) => p.id === self.gitappProjectId)
        : undefined;
      if (project) {
        const reachable = infisicalHostFor(reach, { url: await steps.infisical.resolveBaseUrl() });
        if ('problem' in reachable) {
          if (project.requiredSecrets?.length) throw new Error(reachable.problem);
          console.warn(`[DeployAppActivity] ${project.name} declares no secrets; ${reachable.problem}`);
        } else {
          const masterKey = steps.database.dataKey;
          const synced = await syncProjectSecrets(
            { infra: { runKubectl: kubectl, runHelm: (argv) => access.helm(reach, argv), applyManifest: (manifest) => access.apply(reach, manifest) }, vault: steps.infisical, projects: secretDb.projects, masterKey },
            { project, namespace: namespace, kubeconfig: kubeconfigPath, reach },
          );
          console.log(`[DeployAppActivity] ${project.name}: vault syncs into ${namespace}-secrets from ${synced.hostAPI} (operator ${synced.operator})`);
        }
      }
    } finally {
      await secretDb.close().catch(ignore('the secrets were already synced, and a connection that does not close cleanly holds nothing this deploy needs'));
    }
  }

  if (args.appType === 'palworld') {
    const exists = (await kubectl(['get', 'secret', 'palworld-secrets', '-n', namespace, '--ignore-not-found', '-o', 'name'])).trim() !== '';

    if (!exists) {
      const { randomBytes } = await import('crypto');
      const gen = () => randomBytes(18).toString('base64url');
      const secretYaml = await kubectl(
        ['create', 'secret', 'generic', 'palworld-secrets', '-n', namespace,
          `--from-literal=ADMIN_PASSWORD=${gen()}`,
          `--from-literal=SERVER_PASSWORD=${gen()}`,
          `--from-literal=RCON_PASSWORD=${gen()}`,
          '--dry-run=client', '-o', 'yaml'],
      );
      await access.apply(reach, secretYaml);
      await kubectl(['rollout', 'restart', 'deployment/palworld', '-n', namespace]);
    }
  }

  return {
    status: 'running',
    msg: `App ${args.appType}/${args.name} deployed`,
    displayUrl,
    notes,
  };
}
