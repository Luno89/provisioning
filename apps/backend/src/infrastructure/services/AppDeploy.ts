import path from 'path';
import { randomUUID } from 'node:crypto';
import type { Client } from '@temporalio/client';
import { deploymentIdFor } from '../lib/deployment-id.js';
import { newAppNamespace, sameOwner } from '../lib/app-namespace.js';
import { UnreadableCredential } from './CredentialService.js';
import {
  decryptValue, type SecretKey, type Database, type ClusterMetadata, type CloudCredentials, type DeploymentMetadata,
  type PipelineRunMetadata, type ProjectMetadata, PLATFORM_OWNER, startedFor,
} from '../../platform/index.js';
import { CapacityError, checkCapacity, requestedGpuCount } from '../lib/cluster-capacity.js';
import type { HandOver } from '../lib/cluster-places.js';
import { executeDeployAppWorkflow } from '../../workflows/AppDeployWorkflow.js';
import { resolveVllmDefaults, resolveTabbyDefaults, resolveCrawl4aiDefaults, resolveSearxngDefaults,
  resolveHermesDefaults, resolveMinioDefaults, resolveNextcloudDefaults, resolveQdrantDefaults, resolveQuickwitDefaults } from '../lib/app-env.js';
import { resolveAppSettingsDefaults } from '../lib/app-schemas.js';
import { definedFields, type DeployRequest } from '../lib/deploy-request.js';
import { resolveTabbyCacheHostPath, resolveVllmCacheHostPath } from '../../models/index.js';
import { QUEUES } from '../../platform/index.js';

export const CLUSTER_QUEUE = QUEUES.cluster;

export interface AppDeployDeps {
  db: Database;
  client: () => { workflow: Pick<Client['workflow'], 'start'> };
  masterKey: SecretKey;
  clusterById: (id: string) => Promise<ClusterMetadata | undefined>;
  handOver: (clusterId: string) => Promise<HandOver>;
  ownClusterId: () => string | undefined;
  logDir: string;
}

function savedHuggingFaceToken(credentials: CloudCredentials | undefined, key: SecretKey): string | undefined {
  const sealed = credentials?.huggingface?.hfToken;
  if (!sealed) return undefined;
  try {
    return decryptValue(sealed, key);
  } catch {
    throw new UnreadableCredential('huggingface', 'hfToken');
  }
}

export interface StartedDeploy {
  workflowId: string;
  deployment: DeploymentMetadata;
}

export function resolveOpenaiApiBaseUrl(dep: DeploymentMetadata, allDeployments: DeploymentMetadata[]): string | undefined {
  const targetId = dep.appType === 'hermes' ? dep.hermesTargetId : (dep.appType === 'openwebui' ? dep.openWebuiTargetId : undefined);
  if (!targetId) return undefined;
  const target = allDeployments.find((d) => d.id === targetId);
  if (!target) return undefined;
  if (target.clusterId !== dep.clusterId) {
    console.warn(`[deploy] Open WebUI deployment "${dep.name}" targets "${target.name}" on a different cluster — skipping OPENAI_API_BASE_URL, it must be configured manually.`);
    return undefined;
  }
  if (target.appType !== 'vllm' && target.appType !== 'tabbyapi') return undefined;
  const sanitize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const targetNs = sanitize(target.name);
  return target.appType === 'tabbyapi'
    ? `http://${targetNs}-tabbyapi.${targetNs}.svc.cluster.local:5000/v1`
    : `http://${targetNs}-vllm.${targetNs}.svc.cluster.local:8000/v1`;
}

export async function startAppDeploy(deps: AppDeployDeps, config: DeployRequest, userId?: string): Promise<StartedDeploy> {
    if (userId) {
      const cluster = (await deps.db.infrastructure.getClusters()).find((c: ClusterMetadata) => c.id === config.clusterId)
      const appType = config.appType || 'odoo'
      const problem = checkCapacity(appType, cluster?.capacity, requestedGpuCount(appType, config))
      if (problem) throw new CapacityError(problem)
    }

    const unresolved = await deps.db.infrastructure.getDeployments()
    let [dep] = unresolved.filter((d: DeploymentMetadata) => {
      if (config.name && d.name === config.name && d.clusterId === config.clusterId && sameOwner(d, userId)) return true
      if (config.id && d.id === config.id && sameOwner(d, userId)) return true
      return false
    })
    if (!dep) {
      if (!config.name || !config.clusterId) throw new Error('a new app needs a name and a cluster to deploy to')
      const target = await deps.clusterById(config.clusterId)
      const id = config.id || randomUUID()
      dep = {
        status: 'deploying',
        id,
        name: config.name,
        namespace: config.namespace || newAppNamespace(config.name, id),
        clusterId: target?.id ?? config.clusterId,
        strategy: config.strategy || 'helm',
        appType: config.appType || 'odoo',
        modules: config.modules || [],
        storage: config.storage || {},
        ...definedFields({
          webRepo: config.webRepo || config.odooRepo,
          webTag: config.webTag || config.odooTag,
          dbRepo: config.dbRepo || config.pgRepo,
          dbTag: config.dbTag || config.pgTag,
          url: config.url,
          vllmModel: config.vllmModel,
          vllmGpuCount: config.vllmGpuCount,
          vllmGpuVendor: config.vllmGpuVendor,
          vllmCachePvc: config.vllmCachePvc,
          vllmHfToken: config.vllmHfToken?.trim(),
          vllmMaxModelLen: config.vllmMaxModelLen,
          vllmGpuMemUtil: config.vllmGpuMemUtil,
          vllmExtraArgs: config.vllmExtraArgs,
          vllmToolCallingEnabled: config.vllmToolCallingEnabled,
          vllmToolCallParser: config.vllmToolCallParser,
          vllmServedModelName: config.vllmServedModelName,
          vllmMaxNumSeqs: config.vllmMaxNumSeqs,
          vllmDtype: config.vllmDtype,
          vllmEnablePrefixCaching: config.vllmEnablePrefixCaching,
          tabbyModel: config.tabbyModel,
          tabbyRevision: config.tabbyRevision,
          tabbyGpuCount: config.tabbyGpuCount,
          tabbyHfToken: config.tabbyHfToken?.trim(),
          tabbyCachePvc: config.tabbyCachePvc,
          tabbyImageTag: config.tabbyImageTag,
          tabbyCacheMode: config.tabbyCacheMode,
          tabbyMaxSeqLen: config.tabbyMaxSeqLen,
          tabbyMaxBatchSize: config.tabbyMaxBatchSize,
          tabbyReasoning: config.tabbyReasoning,
          tabbyToolFormat: config.tabbyToolFormat,
          tabbyInlineModelLoading: config.tabbyInlineModelLoading,
          tabbyDisableAuth: config.tabbyDisableAuth,
          tabbyMemoryLimit: config.tabbyMemoryLimit,
          tabbyShmSize: config.tabbyShmSize,
          tabbyCpuLimit: config.tabbyCpuLimit,
          tabbyExtraEnv: config.tabbyExtraEnv,
          searxngSecretKey: config.searxngSecretKey,
          searxngEngines: config.searxngEngines,
          crawl4aiApiToken: config.crawl4aiApiToken,
          crawl4aiMemoryLimit: config.crawl4aiMemoryLimit,
          crawl4aiShmSize: config.crawl4aiShmSize,
          openWebuiTargetId: config.openWebuiTargetId,
          hermesTargetId: config.hermesTargetId,
          webuiEnableWebSearch: config.webuiEnableWebSearch,
          webuiWebSearchEngine: config.webuiWebSearchEngine,
          webuiWebSearchApiKey: config.webuiWebSearchApiKey,
          appSettings: config.appSettings,
        }),
        ...(userId !== undefined ? { ownerId: userId } : {}),
      }
      dep = resolveVllmDefaults(dep as DeploymentMetadata)
      dep = resolveTabbyDefaults(dep as DeploymentMetadata)
      dep = resolveCrawl4aiDefaults(dep as DeploymentMetadata)
      dep = resolveSearxngDefaults(dep as DeploymentMetadata)
      dep = resolveNextcloudDefaults(resolveMinioDefaults(dep as DeploymentMetadata))
      dep = resolveHermesDefaults(dep as DeploymentMetadata)
      dep = resolveQdrantDefaults(dep as DeploymentMetadata)
      dep = resolveQuickwitDefaults(dep as DeploymentMetadata, await deps.db.infrastructure.getDeployments())
      dep = resolveAppSettingsDefaults(dep as DeploymentMetadata)
    }

    if (config.gitappProjectId) dep.gitappProjectId = config.gitappProjectId
    if (config.gitappImageTag) dep.gitappImageTag = config.gitappImageTag

    if (config.gitappImageTag) {
      const at = String(config.gitappImageTag).lastIndexOf(':')
      if (at > 0) {
        dep.webRepo = String(config.gitappImageTag).slice(0, at)
        dep.webTag = String(config.gitappImageTag).slice(at + 1)
      }
    } else {
      const repo = config.webRepo || config.odooRepo
      const tag = config.webTag || config.odooTag
      const placeholder = dep.appType !== 'odoo' && repo === 'library/odoo'
      if (repo && tag && !placeholder) {
        dep.webRepo = repo
        dep.webTag = tag
      }
    }
    if (config.gitappEnv) dep.gitappEnv = config.gitappEnv

    const openaiApiBaseUrl = resolveOpenaiApiBaseUrl(dep, unresolved);

    const servesModel = (type: string | undefined) => type === 'vllm' || type === 'tabbyapi'
    if (!dep.vllmHfToken && !dep.tabbyHfToken && userId && (servesModel(dep.appType) || servesModel(config.appType))) {
      const token = savedHuggingFaceToken((await deps.db.accounts.getUserById(userId))?.credentials, deps.masterKey)
      if (token && dep.appType === 'tabbyapi') dep.tabbyHfToken = token
      else if (token) dep.vllmHfToken = token
    }

  const targetCluster = await deps.clusterById(dep.clusterId)
  const handed = await deps.handOver(dep.clusterId)
  const wfId = `app-deploy-${dep.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const logFileName = `${Date.now()}-${Math.random().toString(36).slice(2)}-C3.log`
  const absoluteLogPath = path.join(deps.logDir, logFileName)
  const deploymentId = deploymentIdFor(dep.deploymentId, dep.id || dep.name);
  dep.deploymentId = deploymentId;

    const activityArgs = {
      name: dep.name,
      namespace: dep.namespace,
      ...handed,
      clusterName: targetCluster?.name || 'unknown',
      ...(dep.appType === 'tabbyapi' && dep.clusterId === deps.ownClusterId()
        ? { modelCacheHostPath: resolveTabbyCacheHostPath(dep.tabbyCachePvc) }
        : {}),
      ...(dep.appType === 'vllm' && dep.clusterId === deps.ownClusterId()
        ? { modelCacheHostPath: resolveVllmCacheHostPath(dep.vllmCachePvc) }
        : {}),
      strategy: dep.strategy || 'helm',
      appType: dep.appType || 'odoo',
      modules: dep.modules || [],
      odooRepo: (dep.webRepo as string) || '',
      odooTag: (dep.webTag as string) || '',
      dbRepo: (dep.dbRepo as string) || '',
      dbTag: (dep.dbTag as string) || '',
      logFile: absoluteLogPath,
      deploymentId,
      vllmModel: dep.vllmModel,
      vllmGpuCount: dep.vllmGpuCount,
      vllmGpuVendor: dep.vllmGpuVendor,
      vllmCachePvc: dep.vllmCachePvc,
      vllmHfToken: dep.vllmHfToken,
      vllmMaxModelLen: dep.vllmMaxModelLen,
      vllmGpuMemUtil: dep.vllmGpuMemUtil,
      vllmExtraArgs: dep.vllmExtraArgs,
      vllmToolCallingEnabled: dep.vllmToolCallingEnabled,
      vllmToolCallParser: dep.vllmToolCallParser,
      vllmServedModelName: dep.vllmServedModelName,
      vllmMaxNumSeqs: dep.vllmMaxNumSeqs,
      vllmDtype: dep.vllmDtype,
      vllmEnablePrefixCaching: dep.vllmEnablePrefixCaching,
      tabbyModel: dep.tabbyModel,
      tabbyRevision: dep.tabbyRevision,
      tabbyGpuCount: dep.tabbyGpuCount,
      tabbyHfToken: dep.tabbyHfToken,
      tabbyCachePvc: dep.tabbyCachePvc,
      tabbyImageTag: dep.tabbyImageTag,
      tabbyCacheMode: dep.tabbyCacheMode,
      tabbyMaxSeqLen: dep.tabbyMaxSeqLen,
      tabbyMaxBatchSize: dep.tabbyMaxBatchSize,
      tabbyReasoning: dep.tabbyReasoning,
      tabbyToolFormat: dep.tabbyToolFormat,
      tabbyInlineModelLoading: dep.tabbyInlineModelLoading,
      tabbyDisableAuth: dep.tabbyDisableAuth,
      tabbyMemoryLimit: dep.tabbyMemoryLimit,
      tabbyShmSize: dep.tabbyShmSize,
      tabbyCpuLimit: dep.tabbyCpuLimit,
      tabbyExtraEnv: dep.tabbyExtraEnv,
      searxngSecretKey: dep.searxngSecretKey,
      searxngEngines: dep.searxngEngines,
      crawl4aiApiToken: dep.crawl4aiApiToken,
      crawl4aiMemoryLimit: dep.crawl4aiMemoryLimit,
      crawl4aiShmSize: dep.crawl4aiShmSize,
      minioRootUser: dep.minioRootUser,
      minioRootPassword: dep.minioRootPassword,
      nextcloudAdminPassword: dep.nextcloudAdminPassword,
      nextcloudDbPassword: dep.nextcloudDbPassword,
      nextcloudDbRootPassword: dep.nextcloudDbRootPassword,
      hermesDashboardPassword: dep.hermesDashboardPassword,
      minioStorage: dep.minioStorage,
      qdrantApiKey: dep.qdrantApiKey,
      qdrantStorage: dep.qdrantStorage,
      qdrantMemoryLimit: dep.qdrantMemoryLimit,
      quickwitS3Endpoint: dep.quickwitS3Endpoint,
      quickwitS3AccessKey: dep.quickwitS3AccessKey,
      quickwitS3SecretKey: dep.quickwitS3SecretKey,
      quickwitBucket: dep.quickwitBucket,
      teiModelId: dep.teiModelId,
      teiUseGpu: dep.teiUseGpu,
      teiMemoryLimit: dep.teiMemoryLimit,
      verdaccioUpstream: dep.verdaccioUpstream,
      verdaccioStorage: dep.verdaccioStorage,
      gitappEnv: dep.gitappEnv,
      ...(openaiApiBaseUrl ? { openaiApiBaseUrl } : {}),
      webuiEnableWebSearch: dep.webuiEnableWebSearch,
      webuiWebSearchEngine: dep.webuiWebSearchEngine,
      webuiWebSearchApiKey: dep.webuiWebSearchApiKey,
      appSettings: dep.appSettings,
    }

    await deps.db.infrastructure.saveDeploymentInfo({
      ...dep,
      id: dep.id || dep.name,
      status: 'deploying',
      healthReason: '',
      deployNotes: [],
      temporalWorkflowId: '',
      lastLogPath: absoluteLogPath,
    })

    await deps.client().workflow.start(executeDeployAppWorkflow, {
      workflowId: wfId,
      taskQueue: CLUSTER_QUEUE,
      args: [activityArgs],
      ...startedFor(dep.ownerId ?? userId ?? PLATFORM_OWNER),
    })

    await deps.db.infrastructure.saveDeploymentInfo({ id: dep.id || dep.name, temporalWorkflowId: wfId })


  return { workflowId: wfId, deployment: dep as DeploymentMetadata };
}

export async function deployProjectBuild(deps: AppDeployDeps, project: ProjectMetadata, run: PipelineRunMetadata, userId?: string): Promise<StartedDeploy> {
  if (!run.imageTag) throw new Error('Pipeline run has no built image to promote');
  if (!project.targetClusterId) throw new Error('Project has no target cluster configured');
  const lastColon = run.imageTag.lastIndexOf(':');
  const started = await startAppDeploy(deps, {
    name: project.name,
    clusterId: project.targetClusterId,
    strategy: 'native',
    appType: 'gitapp',
    odooRepo: run.imageTag.slice(0, lastColon),
    odooTag: run.imageTag.slice(lastColon + 1),
    storage: {},
    gitappProjectId: project.id,
    gitappImageTag: run.imageTag,
    ...(project.deployEnv ? { gitappEnv: project.deployEnv } : {}),
  }, userId ?? project.ownerId);
  await deps.db.releases.savePipelineRunInfo({ id: run.id, promotedAt: new Date().toISOString(), deploymentId: started.deployment.id });
  return started;
}
