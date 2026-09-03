import { randomBytes } from 'node:crypto';
import { renderApp, visibleAppSpecs } from '../lib/app-spec.js';
import { resolveBindings, bindingFiles } from '../lib/binding-resolve.js';
import { bindingProjection, bindingSecretName, type ProjectedBinding } from '../lib/service-binding.js';
import { readBindingCredentials } from '../lib/binding-project.js';
import { createDatabase } from '../lib/db-interface.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';

import { InfrastructureService } from '../services/InfrastructureService.js';
import type { Database } from '../lib/db-interface.js';
import { BuilderService } from '../services/BuilderService.js';
import { StorageAdapter } from '../services/StorageAdapter.js';
import { hasCloudCredentials } from '../lib/credential-resolver.js';
import { isMockCloudProvider, isSelfManagedCluster } from '../lib/cluster-topology.js';
import { buildAppEnv, TABBYAPI_DEFAULT_MAX_SEQ_LEN } from '../lib/app-env.js';
import { GiteaService } from '../services/GiteaService.js';
import { planHostMemory, parseQuantity, type HostMemoryPlan } from '../lib/host-memory-plan.js';
import { deploymentIdFor } from '../lib/deployment-id.js';
import { isValidImageTag } from '../lib/registry-tags.js';
import { sanitiseNamespaceName } from '../lib/projects.js';

async function nodeAllocatableBytes(
  infra: InfrastructureService,
  kubeconfigPath: string,
  logId: string,
): Promise<number | undefined> {
  const res = await infra.runCommand('kubectl', [
    '--kubeconfig', kubeconfigPath,
    'get', 'nodes', '-o', 'jsonpath={.items[*].status.allocatable.memory}',
  ], logId) as { stdout: string; exitCode: number };
  if (res.exitCode !== 0) return undefined;
  const sizes = res.stdout.trim().split(/\s+/)
    .map((q: string) => parseQuantity(q))
    .filter((n): n is number => n !== undefined);
  return sizes.length ? Math.min(...sizes) : undefined;
}

export interface DeployAppArgs {
  name: string;
  clusterId: string;
  clusterName: string;
  provider: string;
  strategy: string;
  appType: string;
  clusterGpuEnabled?: boolean | undefined;
  modules?: string[] | undefined;
  odooRepo: string;
  odooTag: string;
  dbRepo: string;
  dbTag: string;
  logFile: string;
  deploymentId?: string | undefined;
  vllmModel?: string | undefined;
  vllmGpuCount?: number | undefined;
  vllmGpuVendor?: 'nvidia' | 'amd' | undefined;
  vllmCachePvc?: string | undefined;
  vllmHfToken?: string | undefined;
  vllmMaxModelLen?: number | undefined;
  vllmGpuMemUtil?: number | undefined;
  vllmExtraArgs?: string | undefined;
  vllmToolCallingEnabled?: boolean | undefined;
  vllmToolCallParser?: string | undefined;
  vllmServedModelName?: string | undefined;
  vllmMaxNumSeqs?: number | undefined;
  vllmDtype?: string | undefined;
  vllmEnablePrefixCaching?: boolean | undefined;
  tabbyModel?: string | undefined;
  tabbyRevision?: string | undefined;
  tabbyGpuCount?: number | undefined;
  tabbyHfToken?: string | undefined;
  tabbyCachePvc?: string | undefined;
  tabbyImageTag?: string | undefined;
  tabbyCacheMode?: string | undefined;
  tabbyMaxSeqLen?: number | undefined;
  tabbyMaxBatchSize?: number | undefined;
  tabbyReasoning?: boolean | undefined;
  tabbyToolFormat?: string | undefined;
  tabbyInlineModelLoading?: boolean | undefined;
  tabbyMemoryLimit?: string | undefined;
  tabbyShmSize?: string | undefined;
  tabbyCpuLimit?: string | undefined;
  tabbyDisableAuth?: boolean | undefined;
  tabbyExtraEnv?: string | undefined;
  searxngSecretKey?: string | undefined;
  searxngEngines?: string | undefined;
  crawl4aiApiToken?: string | undefined;
  crawl4aiMemoryLimit?: string | undefined;
  crawl4aiShmSize?: string | undefined;
  minioRootUser?: string | undefined;
  minioRootPassword?: string | undefined;
  minioStorage?: string | undefined;
  qdrantApiKey?: string | undefined;
  qdrantStorage?: string | undefined;
  qdrantMemoryLimit?: string | undefined;
  quickwitS3Endpoint?: string | undefined;
  quickwitS3AccessKey?: string | undefined;
  quickwitS3SecretKey?: string | undefined;
  quickwitBucket?: string | undefined;
  teiModelId?: string | undefined;
  teiUseGpu?: boolean | undefined;
  teiMemoryLimit?: string | undefined;
  verdaccioUpstream?: string | undefined;
  verdaccioStorage?: string | undefined;
  gitappEnv?: string | undefined;
  modelCacheHostPath?: string | undefined;
  openaiApiBaseUrl?: string | undefined;
  webuiEnableWebSearch?: boolean | undefined;
  webuiWebSearchEngine?: string | undefined;
  webuiWebSearchApiKey?: string | undefined;
  appSettings?: Record<string, string> | undefined;
}

export interface DeployAppResult {
  status: string;
  msg: string;
  displayUrl: string;
}

export { deployAppActivityMeta } from '../lib/activity-timeouts.js';

const SANITIZE = sanitiseNamespaceName;
const LIVE_ROOT = process.cwd();

export async function DeployAppActivity(
  args: DeployAppArgs,
): Promise<DeployAppResult> {
  const infra = new InfrastructureService();
  const builder = new BuilderService({} as unknown as Database, infra);
  const logFile = args.logFile;
  const sanitizedName = SANITIZE(args.name);

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
    minio: { repo: 'minio/minio', tag: 'latest' },
    qdrant: { repo: 'qdrant/qdrant', tag: 'latest' },
    quickwit: { repo: 'quickwit/quickwit', tag: 'latest' },
    tei: { repo: 'ghcr.io/huggingface/text-embeddings-inference', tag: 'cpu-latest' },
    verdaccio: { repo: 'verdaccio/verdaccio', tag: 'latest' },
  };

  const appDefault = DEFAULT_APP_REPOS[args.appType] || { repo: '', tag: 'latest' };
  const sentOdooFallback = args.appType !== 'odoo' && args.odooRepo === 'library/odoo';
  let finalOdooRepo = sentOdooFallback ? appDefault.repo : (args.odooRepo || appDefault.repo);
  let finalOdooTag = sentOdooFallback ? appDefault.tag : (args.odooTag || appDefault.tag);

  const isMock = isMockCloudProvider(args.provider, hasCloudCredentials);
  const physicalName = isMock ? `mock-${args.provider}-${args.clusterName}` : args.clusterName;

  let customImageTag: string | undefined;

  const kubeconfigPath = isSelfManagedCluster(args.provider, isMock)
    ? `/tmp/kubeconfig-${physicalName}`
    : path.join(LIVE_ROOT, '.kube/config');

  let effectiveDevice = process.env.VLLM_DEVICE || (args.vllmGpuCount === 0 ? 'cpu' : (args.vllmGpuVendor === 'amd' ? 'rocm' : 'cuda'));
  let effectiveGpuCount = args.vllmGpuCount !== undefined ? args.vllmGpuCount : 1;

  if (args.appType === 'vllm' && (args.provider === 'k3d' || isMock)) {
    if (effectiveGpuCount > 0 && effectiveDevice !== 'cpu') {
      const gpuVendor = args.vllmGpuVendor || 'nvidia';
      try {
        await infra.checkGpuToolkit(gpuVendor);
        await infra.installGpuDevicePlugin(gpuVendor, kubeconfigPath);
      } catch (err: any) {
        console.warn(`[DeployAppActivity] GPU toolkit check or device plugin install failed (${err.message}). Falling back to CPU mode.`);
        effectiveDevice = 'cpu';
        effectiveGpuCount = 0;
      }
    }
  }

  const effectiveTabbyGpuCount = args.tabbyGpuCount !== undefined ? args.tabbyGpuCount : 1;
  if (args.appType === 'tabbyapi' && (args.provider === 'k3d' || isMock) && effectiveTabbyGpuCount > 0) {
    try {
      await infra.checkGpuToolkit('nvidia');
      await infra.installGpuDevicePlugin('nvidia', kubeconfigPath);
    } catch (err: any) {
      console.warn(`[DeployAppActivity] GPU toolkit check or device plugin install failed (${err.message}). TabbyAPI requires an NVIDIA GPU and cannot run in CPU mode.`);
    }
  }

  if (args.modules && args.modules.length > 0) {
    const baseImage = (finalOdooRepo && finalOdooTag) ? `${finalOdooRepo}:${finalOdooTag}` : (args.odooRepo || 'odoo:latest');
    customImageTag = await builder.buildCustomImage(
      baseImage,
      args.modules,
      args.appType,
      { logFile, resourceId: args.clusterId },
    );
    if (customImageTag) {
      if (args.clusterGpuEnabled) {
        console.warn(`[DeployAppActivity] Skipping k3d image import for GPU-attached cluster — custom-built image "${customImageTag}" exists only in the host's Docker daemon and is NOT visible to native k3s's containerd. The deployment will likely fail to pull it (ImagePullBackOff) unless it's pushed to a registry.`);
      } else {
        await infra.importImage(physicalName, customImageTag, { logFile });
      }
      const [repo, imageTag] = customImageTag.split(':');
      finalOdooRepo = repo || finalOdooRepo;
      finalOdooTag = imageTag || finalOdooTag;
    }
  } else if ((args.provider === 'k3d' || isMock) && !args.clusterGpuEnabled) {
    if (args.appType === 'vllm') {
      const vllmImageTag = isValidImageTag(finalOdooTag) ? finalOdooTag : 'latest';
      const vllmImage = args.vllmGpuVendor === 'amd'
        ? `vllm/vllm-openai-rocm:${vllmImageTag}`
        : `vllm/vllm-openai:${vllmImageTag}`;
      await infra.pullAndImportImage(physicalName, vllmImage, { logFile });
    } else if (args.appType === 'tabbyapi') {
      const tabbyImageTag = isValidImageTag(args.tabbyImageTag) ? args.tabbyImageTag : 'latest';
      await infra.pullAndImportImage(physicalName, `ghcr.io/theroyallab/tabbyapi:${tabbyImageTag}`, { logFile });
    } else if (args.appType === 'palworld') {
      const palworldImage = `${finalOdooRepo || 'thijsvanloef/palworld-server-docker'}:${finalOdooTag || 'latest'}`;
      await infra.pullAndImportImage(physicalName, palworldImage, { logFile });
    } else if (finalOdooRepo && finalOdooTag) {
      const appImage = `${finalOdooRepo}:${finalOdooTag}`;
      await infra.pullAndImportImage(physicalName, appImage, { logFile });
    }
    if (args.dbRepo && args.dbTag) {
      const dbImage = `${args.dbRepo}:${args.dbTag}`;
      await infra.pullAndImportImage(physicalName, dbImage, { logFile });
    }
  }

  if (args.appType === 'palworld') {
    const REQUIRED_GI = 12;
    try {
      const nodesJson = await infra.runKubectl(['get', 'nodes', '-o', 'json'], kubeconfigPath);
      const nodes = JSON.parse(nodesJson).items ?? [];
      const toGi = (q: string): number => {
        const m = /^(\d+)(Ki|Mi|Gi)?$/.exec(q ?? '');
        if (!m?.[1]) return 0;
        const n = Number(m[1]);
        return m[2] === 'Gi' ? n : m[2] === 'Mi' ? n / 1024 : n / (1024 * 1024);
      };
      const largest = Math.max(0, ...nodes.map((n: any) => toGi(n.status?.allocatable?.memory)));
      if (largest > 0 && largest < REQUIRED_GI) {
        throw new Error(
          `Palworld needs a node with at least ${REQUIRED_GI}Gi allocatable memory; the largest node in this ` +
          `cluster has ${largest.toFixed(1)}Gi. Deploy to a bigger cluster (Hetzner CX53 or larger).`,
        );
      }
    } catch (err: any) {
      if (err?.message?.includes('allocatable memory')) throw err;
      console.warn(`[DeployAppActivity] Palworld node-size preflight skipped: ${err.message}`);
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

  const deploymentId = deploymentIdFor(args.deploymentId, args.name);

  let tabbyModelSizeBytes: number | undefined;
  if (args.appType === 'tabbyapi' && args.tabbyModel) {
    try {
      const { getHfModelSize } = await import('../lib/huggingface.js');
      const size = await getHfModelSize(args.tabbyModel, args.tabbyRevision, args.tabbyHfToken);
      tabbyModelSizeBytes = size.totalBytes;
    } catch (err: any) {
      console.warn(`[DeployAppActivity] Could not fetch model size for ${args.tabbyModel}: ${err.message}`);
    }
  }

  let tabbyMemoryPlan: HostMemoryPlan | undefined;
  if (args.appType === 'tabbyapi') {
    const allocatableBytes = await nodeAllocatableBytes(infra, kubeconfigPath, physicalName).catch(() => undefined);
    tabbyMemoryPlan = planHostMemory({
      modelBytes: tabbyModelSizeBytes,
      gpuCount: effectiveTabbyGpuCount,
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
  try {
    const specDb = createDatabase();
    await specDb.init();
    const stored = (await specDb.getAppSpecs()).find((s) => s.id === args.appType)
      ?? undefined;
    await specDb.close().catch(() => undefined);
    if (stored) {
      const secrets: Record<string, string> = {};
      for (const e of stored.spec.env ?? []) {
        if (e.generate && e.fromSecret) {
          secrets[e.fromSecret] = e.generate === 'username'
            ? 'koala'
            : randomBytes(24).toString('hex');
        }
      }
      renderedSpec = renderApp(stored.spec, {
        id: deploymentId,
        namespace: sanitizedName,
        serviceType: isSelfManagedCluster(args.provider, isMock) ? 'NodePort' : 'LoadBalancer',
        secrets,
      });
      console.log(`[DeployAppActivity] ${args.appType} deploying from a stored spec, not a construct`);
    }
  } catch (err: any) {
    console.warn(`[DeployAppActivity] could not read app specs: ${err.message}`);
  }

  let bindingsJson = '';
  try {
    const bindDb = createDatabase();
    await bindDb.init();
    const deployments = await bindDb.getDeployments();
    const self = deployments.find((d) => d.name === args.name || d.id === args.name);
    const project = self?.gitappProjectId
      ? (await bindDb.getProjects()).find((p) => p.id === self.gitappProjectId)
      : undefined;
    const needs = project?.needs ?? [];
    const specs = needs.length && project?.ownerId
      ? visibleAppSpecs(await bindDb.getAppSpecs(), project.ownerId)
      : [];
    const dynamicTypes = needs.length ? await bindDb.getBindingTypes().catch(() => []) : [];
    await bindDb.close().catch(() => undefined);

    if (needs.length && project?.ownerId) {
      const { bindings, problems } = resolveBindings(needs, deployments, specs, project.ownerId, { dynamicTypes });
      for (const p of problems) console.warn(`[bindings] ${physicalName}: ${p}`);

      const projected: ProjectedBinding[] = [];
      for (const b of bindings) {
        const credentials = await readBindingCredentials(async (args) => {
          const raw = await infra.runKubectl(args, kubeconfigPath);
          return typeof raw === 'string' ? raw : ((raw as any)?.stdout ?? '');
        }, b);

        const secretName = bindingSecretName(b.name);
        const files = bindingFiles(b, credentials);
        const manifest = JSON.stringify({
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: { name: secretName, namespace: sanitizedName },
          type: 'Opaque',
          stringData: files,
        });
        const manifestPath = path.join(os.tmpdir(), `binding-${sanitizedName}-${b.name}-${Date.now()}.json`);
        try {
          await fs.writeFile(manifestPath, manifest, { encoding: 'utf-8', mode: 0o600 });
          await infra.runKubectl(['apply', '-f', manifestPath], kubeconfigPath);
        } catch (err: any) {
          console.warn(`[bindings] could not write ${secretName}: ${err.message}`);
        } finally {
          await fs.unlink(manifestPath).catch(() => undefined);
        }
        projected.push({ name: b.name, secretName });
        console.log(`[bindings] ${physicalName}: bound ${b.name} (${b.type}) from ${b.source.namespace}`);
      }
      if (projected.length) bindingsJson = JSON.stringify(bindingProjection(projected));
    }
  } catch (err: any) {
    console.warn(`[bindings] ${physicalName}: ${err.message}`);
  }

  const env = buildAppEnv({
    ...(renderedSpec ? { renderedSpec } : {}),
    ...(bindingsJson ? { bindingsJson } : {}),
    physicalName,
    strategy: args.strategy,
    sanitizedName,
    deploymentId,
    kubeconfigPath,
    provider: args.provider,
    isMock,
    appType: args.appType,
    webRepo: finalOdooRepo,
    webTag: finalOdooTag,
    dbRepo: args.dbRepo,
    dbTag: args.dbTag,
    vllmModel: args.vllmModel,
    vllmGpuCount: effectiveGpuCount,
    vllmGpuVendor: args.vllmGpuVendor,
    vllmCachePvc: args.vllmCachePvc,
    vllmDevice: effectiveDevice,
    vllmHfToken: args.vllmHfToken,
    vllmMaxModelLen: args.vllmMaxModelLen,
    vllmGpuMemUtil: args.vllmGpuMemUtil,
    vllmExtraArgs: args.vllmExtraArgs,
    vllmToolCallingEnabled: args.vllmToolCallingEnabled,
    vllmToolCallParser: args.vllmToolCallParser,
    vllmServedModelName: args.vllmServedModelName,
    vllmMaxNumSeqs: args.vllmMaxNumSeqs,
    vllmDtype: args.vllmDtype,
    vllmEnablePrefixCaching: args.vllmEnablePrefixCaching,
    tabbyModel: args.tabbyModel,
    tabbyRevision: args.tabbyRevision,
    tabbyGpuCount: effectiveTabbyGpuCount,
    tabbyModelSizeBytes,
    tabbyHfToken: args.tabbyHfToken,
    tabbyCachePvc: args.tabbyCachePvc,
    tabbyImageTag: args.tabbyImageTag,
    tabbyCacheMode: args.tabbyCacheMode,
    tabbyMaxSeqLen: args.tabbyMaxSeqLen,
    tabbyMaxBatchSize: args.tabbyMaxBatchSize,
    tabbyReasoning: args.tabbyReasoning,
    tabbyToolFormat: args.tabbyToolFormat,
    tabbyInlineModelLoading: args.tabbyInlineModelLoading,
    tabbyMemoryLimit: args.tabbyMemoryLimit
      || (tabbyMemoryPlan ? `${Math.ceil(tabbyMemoryPlan.limitBytes / 1e9)}G` : undefined),
    tabbyShmSize: args.tabbyShmSize
      || (tabbyMemoryPlan ? `${Math.ceil(tabbyMemoryPlan.shmBytes / 1024 ** 3)}Gi` : undefined),
    tabbyCpuLimit: args.tabbyCpuLimit,
    tabbyDisableAuth: args.tabbyDisableAuth,
    tabbyExtraEnv: args.tabbyExtraEnv,
    searxngSecretKey: args.searxngSecretKey,
    searxngEngines: args.searxngEngines,
    crawl4aiApiToken: args.crawl4aiApiToken,
    crawl4aiMemoryLimit: args.crawl4aiMemoryLimit,
    crawl4aiShmSize: args.crawl4aiShmSize,
    minioRootUser: args.minioRootUser,
    minioRootPassword: args.minioRootPassword,
    minioStorage: args.minioStorage,
    qdrantApiKey: args.qdrantApiKey,
    qdrantStorage: args.qdrantStorage,
    qdrantMemoryLimit: args.qdrantMemoryLimit,
    quickwitS3Endpoint: args.quickwitS3Endpoint,
    quickwitS3AccessKey: args.quickwitS3AccessKey,
    quickwitS3SecretKey: args.quickwitS3SecretKey,
    quickwitBucket: args.quickwitBucket,
    teiModelId: args.teiModelId,
    teiUseGpu: args.teiUseGpu,
    teiMemoryLimit: args.teiMemoryLimit,
    verdaccioUpstream: args.verdaccioUpstream,
    verdaccioStorage: args.verdaccioStorage,
    gitappEnv: args.gitappEnv,
    openaiApiBaseUrl: args.openaiApiBaseUrl,
    webuiEnableWebSearch: args.webuiEnableWebSearch,
    webuiWebSearchEngine: args.webuiWebSearchEngine,
    webuiWebSearchApiKey: args.webuiWebSearchApiKey,
    ...(args.appSettings ? { appSettings: args.appSettings } : {}),
    storageEnv,
  });

  await infra.deploy(
    `app-${physicalName}-${deploymentId}`,
    { logFile, env },
  );

  if (args.appType === 'gitapp') {
    const gitea = new GiteaService(infra, process.env.JWT_SECRET || 'provisioning-platform-secret-12345', '/tmp/kubeconfig-provisioning-lunorica');
    const registryHost = await gitea.getRegistryHost();
    const deployToken = await gitea.createDeployToken();
    const secretYaml = await infra.runKubectl(
      ['create', 'secret', 'docker-registry', 'gitea-registry', '-n', sanitizedName,
        `--docker-server=${registryHost}`, `--docker-username=${gitea.adminUsername}`, `--docker-password=${deployToken.token}`,
        '--dry-run=client', '-o', 'yaml'],
      kubeconfigPath,
    );
    const tmpSecretPath = path.join(os.tmpdir(), `gitapp-registry-secret-${deploymentId}.yaml`);
    await fs.writeFile(tmpSecretPath, secretYaml as any);
    await infra.runKubectl(['apply', '-f', tmpSecretPath], kubeconfigPath);
    await fs.rm(tmpSecretPath, { force: true }).catch(() => {});
  }

  if (args.appType === 'palworld') {
    const exists = await infra
      .runKubectl(['get', 'secret', 'palworld-secrets', '-n', sanitizedName], kubeconfigPath)
      .then(() => true)
      .catch(() => false);

    if (!exists) {
      const { randomBytes } = await import('crypto');
      const gen = () => randomBytes(18).toString('base64url');
      const secretYaml = await infra.runKubectl(
        ['create', 'secret', 'generic', 'palworld-secrets', '-n', sanitizedName,
          `--from-literal=ADMIN_PASSWORD=${gen()}`,
          `--from-literal=SERVER_PASSWORD=${gen()}`,
          `--from-literal=RCON_PASSWORD=${gen()}`,
          '--dry-run=client', '-o', 'yaml'],
        kubeconfigPath,
      );
      const tmpPath = path.join(os.tmpdir(), `palworld-secrets-${deploymentId}.yaml`);
      await fs.writeFile(tmpPath, secretYaml as any, { mode: 0o600 });
      try {
        await infra.runKubectl(['apply', '-f', tmpPath], kubeconfigPath);
      } finally {
        await fs.rm(tmpPath, { force: true }).catch(() => {});
      }
      await infra
        .runKubectl(['rollout', 'restart', 'deployment/palworld', '-n', sanitizedName], kubeconfigPath)
        .catch((err: any) => console.warn(`[DeployAppActivity] palworld restart after secret creation failed: ${err.message}`));
    }
  }

  return {
    status: 'running',
    msg: `App ${args.appType}/${args.name} deployed`,
    displayUrl,
  };
}
