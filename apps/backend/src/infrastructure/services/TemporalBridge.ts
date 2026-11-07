import path from 'path';
import { isCommitSha, type BuildPlan } from '../../releases/index.js'
import {
  stopIfRunning, getTemporalClient, closedAs, reopening, type ClosedAs, type Watching, decryptValue, encryptValue, type SecretKey, type Database,
  type CloudCredentials, type ClusterMetadata, type ClusterProgress, type DeploymentMetadata, type ProjectMetadata,
  type PipelineRunMetadata, type ClaimSettings, PLATFORM_OWNER, ownerIn, startedFor,
} from '../../platform/index.js'
import {
  looksLikeMcp, namespaceOfDeployment, cachedProbes, corpusEndpointsWith, webToolsDepsFrom, type WaitingAsk,
} from '../../engine/index.js'
import type { DeploymentHealth } from '../store.js'
import { missingNamespaceReason, namespacesByName, namespaceOf, removalHoldOf } from '../lib/app-namespace.js'
import { healthFromProbe } from '../lib/service-health.js'
import { clusterFieldsFrom } from '../lib/provisioned-cluster.js'
import { followedAction, type FollowedAction, type FollowedRecord } from '../lib/followed-work.js'
import { fileURLToPath } from 'url';
import fs from 'fs';
import { isGrpcServiceError, WorkflowNotFoundError, type Client, type WorkflowExecutionInfo } from '@temporalio/client'
import type { temporal } from '@temporalio/proto'
import { ignore } from '@koala/engine-core/failures'
import { textAt } from '../../platform/index.js'
import { definedFields, deployRequestOf } from '../lib/deploy-request.js'
import { AdoptPlanWorkflow } from '../../workflows/AdoptPlanWorkflow.js'
import { executeIngestWorkflow } from '../../workflows/IngestWorkflow.js'

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_DIR = path.resolve(__dirname, '../../../data/logs');
import { DEFAULT_ENGINE_TASK_QUEUE, type GroveRunResult } from '../../engine-host/temporal/contracts.js'

export type GroveRunStatus =
  | { state: 'none' | 'unavailable' }
  | { state: 'running'; startedAt: string; turnId?: string | undefined; asking?: WaitingAsk[] | undefined }
  | { state: 'finished'; startedAt: string; closedAt?: string; result: GroveRunResult; turnId?: string | undefined }
  | { state: 'failed'; startedAt: string; closedAt?: string; reason: string; turnId?: string | undefined }
import { deploymentForProject } from '../../projects/index.js'
import { destroyAppArgs, destroyAppWorkflowId } from '../lib/app-destroy.js'
import { COMBINED_CLAIMS, usesOperatorCredentials } from '../lib/credential-resolver.js'
import { resolveCloudCredentials } from './cloud-credentials.js'
import { mockableProvider, ProvisionRefused, provisionRefusal } from '../lib/cluster-topology.js'
import { CredentialService } from './CredentialService.js'
import { generateSshKeypair } from '../lib/ssh-keypair.js'
import { consolidateMemories, type ConsolidationReport, indexMemories, similarTo } from '../../memory/index.js'
import { sharedClusterProxy } from './ClusterProxyService.js'
import { assessWorkload, reconciledStatus } from '../lib/workload-health.js'
import type { Reach } from '../lib/cluster-places.js'
import { isModelKind } from '../../models/index.js'
import { ClusterService } from './ClusterService.js'
import { ClusterProvisionWorkflow } from '../../workflows/ClusterProvisionWorkflow.js'
import { executeDestroyClusterWorkflow } from '../../workflows/DestroyClusterWorkflow.js'
import { deployProjectBuild, startAppDeploy, resolveOpenaiApiBaseUrl, type AppDeployDeps } from './AppDeploy.js'
import { executeDestroyAppWorkflow } from '../../workflows/DestroyAppWorkflow.js'
import { executeResizeDiskWorkflow } from '../../workflows/ResizeDiskWorkflow.js'
import { executeSyncConfigWorkflow } from '../../workflows/SyncConfigWorkflow.js'
import { executePipelineRunWorkflow } from '../../workflows/PipelineRunWorkflow.js'
import { resolveVllmDefaults, resolveTabbyDefaults, resolveCrawl4aiDefaults, resolveSearxngDefaults,
  resolveHermesDefaults, resolveMinioDefaults, resolveNextcloudDefaults, resolveQdrantDefaults, resolveQuickwitDefaults } from '../lib/app-env.js'
import { resolveAppSettingsDefaults } from '../lib/app-schemas.js'
import type { Server as SocketServer } from 'socket.io'

const GRPC_NOT_FOUND = 5

const HOST_QUEUE = 'host-ops-queue'
const CLUSTER_QUEUE = 'cluster-ops-queue'
const RECONCILE_INTERVAL = 30000

const CONSOLIDATE_INTERVAL = 1_800_000

const DEEP_MERGE_FIELDS = ['storage', 'appSettings'] as const

type TrackedDeployment = DeploymentMetadata & { newStorage?: Record<string, string> | undefined }

export type WorkflowSummary = {
  workflowId: string
  runId: string
  type: string
  taskQueue: string
  status: string
  startTime: string
  closeTime: string | undefined
  historyLength: number
  owner: string | undefined
}

const summaryOf = (wf: Omit<WorkflowExecutionInfo, 'raw'>): WorkflowSummary => ({
  workflowId: wf.workflowId,
  runId: wf.runId,
  type: wf.type,
  taskQueue: wf.taskQueue,
  status: wf.status.name,
  startTime: wf.startTime.toISOString(),
  closeTime: wf.closeTime?.toISOString(),
  historyLength: wf.historyLength,
  owner: ownerIn(wf.typedSearchAttributes),
})

const attributesOf = (event: temporal.api.history.v1.IHistoryEvent): string | null => {
  const found = Object.entries(event).find(([key, value]) => key.endsWith('Attributes') && value)
  return found ? JSON.stringify(found[1]).slice(0, 500) : null
}

export interface WorkflowDeal {
  readonly id: string
  readonly event: string
}

export interface ResourceDeal extends WorkflowDeal {
  readonly resourceId: string
}

export type TemporalReach =
  | { connected: true; serverVersion?: string }
  | { connected: false; reason: string }

export interface NothingToBuild {
  readonly event: 'nothing-to-build'
  readonly reason: string
}

export type TemporalConnect = (options?: { address?: string }) => Promise<Client>

async function getDefaultClient(address?: string, connect: TemporalConnect = getTemporalClient): Promise<Client> {
  return connect({ ...(address !== undefined ? { address } : {}) })
}

async function updateUserStatus(
  db: Database,
  clusterId: string,
  clusterName: string,
  provider: ClusterMetadata['provider'] | '' | undefined,
  status: ClusterMetadata['status'],
  kubeconfigPath?: string,
): Promise<void> {
  const clusters = await db.infrastructure.getClusters();
  const existing = clusters.find((c) => c.id === clusterId);

  if (status === 'destroyed') {
    await db.infrastructure.deleteCluster(clusterId);
    return;
  }
  await db.infrastructure.saveClusterInfo({
    ...(existing ?? {}),
    id: clusterId,
    name: clusterName,
    ...(provider ? { provider } : {}),
    status,
    kubeconfigPath: kubeconfigPath ?? existing?.kubeconfigPath,
  })
}

async function updatePipelineRunStatus(
  db: Database,
  runId: string,
  status: 'queued' | 'running' | 'succeeded' | 'failed',
  extra: { imageTag?: string; errorMessage?: string } = {},
): Promise<void> {
  const runs = await db.releases.getPipelineRuns();
  const existing = runs.find((r) => r.id === runId);
  if (!existing) return;
  const imageTag = extra.imageTag ?? existing.imageTag;
  const errorMessage = extra.errorMessage ?? existing.errorMessage;
  await db.releases.savePipelineRunInfo({
    ...existing,
    status,
    ...(imageTag !== undefined ? { imageTag } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    finishedAt: new Date().toISOString(),
  });
  if (status === 'succeeded' || status === 'failed') {
    const projects = await db.projects.getProjects();
    const project = projects.find((p) => p.id === existing.projectId);
    if (project) {
      await db.projects.saveProjectInfo({ ...project, lastBuildStatus: status });
    }
  }
}

async function updateDeploymentStatus(
  db: Database,
  deploymentId: string,
  deployment: DeploymentMetadata,
  status: DeploymentMetadata['status'],
  storage: Record<string, string> | undefined = undefined,
): Promise<void> {
  const deployments = await db.infrastructure.getDeployments();
  const existing = deployments.find((d) => d.id === deploymentId);
  await db.infrastructure.saveDeploymentInfo({
    ...deployment,
    id: deploymentId,
    status,
    ...(storage !== undefined ? { storage } : {}),
    ...(existing?.temporalWorkflowId !== undefined ? { temporalWorkflowId: existing.temporalWorkflowId } : {}),
    ...(existing?.lastLogPath !== undefined ? { lastLogPath: existing.lastLogPath } : {}),
    ...(existing?.deploymentId !== undefined ? { deploymentId: existing.deploymentId } : {}),
    ...(existing?.ownerId !== undefined ? { ownerId: existing.ownerId } : {}),
  })
}

async function maybeSetDefaultModel(
  db: Database,
  deploymentId: string,
  ownerId: string | undefined,
  appType: string | undefined,
): Promise<void> {
  if (!ownerId || !isModelKind(appType)) return
  const user = await db.accounts.getUserById(ownerId)
  if (!user || user.defaultModelId) return
  await db.accounts.saveUser({ ...user, defaultModelId: deploymentId })
}

export const connectToTemporal = async (address: string, connect: TemporalConnect = getTemporalClient): Promise<Client> => {
  const c = await getDefaultClient(address, connect)
  return c
}

function inferProgressFromLog(logPath: string): ClusterProgress | null {
  try {
    const content = fs.readFileSync(logPath, 'utf-8')
    const lines = content.split('\n')
    const steps = [
      { step: 'deploying-cdktf', keywords: ['Deploying', 'terraform', 'cdktf', 'Apply complete'] },
      { step: 'installing-traefik', keywords: ['traefik', 'helm.*traefik'] },
      { step: 'installing-prometheus', keywords: ['prometheus', 'kube-prometheus-stack'] },
      { step: 'patching-coredns', keywords: ['CoreDNS', 'coredns', 'dns'] },
      { step: 'patching-storage', keywords: ['StorageClass', 'storageclass', 'volume expansion'] },
      { step: 'creating-cluster', keywords: ['Creating', 'k3d.*create', 'cluster create'] },
    ]

    let lastStep = null
    let lastMessage = ''
    let lastTimestamp = new Date().toISOString()

    for (const line of lines) {
      const cleanLine = line.replace(/\x1B\[[0-9;]*m/g, '').trim()
      if (!cleanLine) continue

      for (const s of steps) {
        for (const kw of s.keywords) {
          if (new RegExp(kw, 'i').test(cleanLine)) {
            lastStep = s.step
            lastMessage = cleanLine.substring(0, 120)
            const timeMatch = cleanLine.match(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/)
            if (timeMatch?.[1]) lastTimestamp = timeMatch[1]
            break
          }
        }
        if (lastStep === s.step) break
      }
    }

    if (lastStep) {
      return { step: lastStep, message: lastMessage, timestamp: lastTimestamp }
    }
    return null
  } catch {
    return null
  }
}

export class TemporalBridge {
  db!: Database
  private readonly mcpProbes = cachedProbes()
  io: SocketServer | undefined
  client!: Client
  masterKey: SecretKey
  private readonly following = new Map<string, Promise<void>>()
  private watching: Watching[] = []
  clusterService?: ClusterService
  headscale?: { createPreAuthKey(userId: string, opts?: { reusable?: boolean; expirySeconds?: number }): Promise<{ key: string }> }

  lastConsolidation?: ConsolidationReport

  constructor(
    db: Database,
    io?: SocketServer,
    masterKey?: SecretKey,
    clusterService?: ClusterService,
    headscale?: { createPreAuthKey(userId: string, opts?: { reusable?: boolean; expirySeconds?: number }): Promise<{ key: string }> },
    private readonly claims: ClaimSettings = COMBINED_CLAIMS,
    private readonly seams: { connect?: TemporalConnect | undefined; generateKeypair?: typeof generateSshKeypair | undefined } = {},
  ) {
    this.db = db
    this.io = io
    this.masterKey = masterKey || ''
    if (clusterService !== undefined) this.clusterService = clusterService
    if (headscale !== undefined) this.headscale = headscale
  }

  private clustersForConsolidation(): ClusterService {
    if (!this.clusterService) throw new Error('memories are consolidated through the cluster service, and this bridge was given none')
    return this.clusterService
  }

  onBuilt?: (project: ProjectMetadata, run: PipelineRunMetadata) => Promise<boolean>

  ensureSecrets?: (project: ProjectMetadata) => Promise<{ waiting: string[] }>
  decideRelease?: (project: ProjectMetadata, since: string, commit: string) => Promise<{ release: true } | { release: false; reason: string }>
  planBuild?: (project: ProjectMetadata, commitSha: string) => Promise<BuildPlan>

  isReady(): boolean {
    return !!this.client
  }

  async reach(): Promise<TemporalReach> {
    if (!this.client) return { connected: false, reason: 'the backend has not connected to Temporal yet' }
    try {
      const { serverVersion } = await this.client.workflowService.getSystemInfo({})
      return serverVersion ? { connected: true, serverVersion } : { connected: true }
    } catch (err) {
      return { connected: false, reason: (err as Error).message }
    }
  }

  private async getClusterById(id: string): Promise<ClusterMetadata | undefined> {
    if (this.clusterService?.isKoalasCluster(id)) {
      return this.clusterService.getSystemClusterEntry();
    }
    const clusters = await this.db.infrastructure.getClusters();
    return clusters.find((c: ClusterMetadata) => c.id === id);
  }

  async start(address?: string): Promise<this> {
    const c = await getDefaultClient(address, this.seams.connect)
    this.client = c
    return this
  }

  async flush(): Promise<void> {
  }

  async stop(): Promise<void> {
    await Promise.all(this.watching.splice(0).map((watching) => watching.close()))
    try {
      await this.client.connection.close()
    } catch (failure) {
      ignore('a connection to Temporal that is already closed has nothing left to close')(failure)
    }
  }

  private async recordProvisioned(workflowId: string, cluster: { id: string; name: string; provider: ClusterMetadata['provider'] | '' }): Promise<string | undefined> {
    try {
      const provisioned = await this.client.workflow.getHandle<typeof ClusterProvisionWorkflow>(workflowId).result()
      const fields = clusterFieldsFrom(provisioned, (secret) => encryptValue(secret, this.masterKey))
      if (Object.keys(fields).length > 0) {
        const current = (await this.db.infrastructure.getClusters()).find((c: ClusterMetadata) => c.id === cluster.id)
        await this.db.infrastructure.saveClusterInfo({ ...(current ?? {}), id: cluster.id, name: cluster.name, ...(cluster.provider ? { provider: cluster.provider } : {}), ...fields })
      }
      return provisioned.kubeconfig
    } catch (err) {
      console.error(`[TemporalBridge] Cluster ${cluster.id} provisioned, but what it was given could not be recorded: ${(err as Error).message}`)
      return undefined
    }
  }

  private async appliedOutcome(
    wfId: string,
    meta: TrackedDeployment,
  ): Promise<{ status: 'running' | 'unhealthy'; meta: TrackedDeployment }> {
    let verdict: unknown
    try {
      verdict = await this.client.workflow.getHandle(wfId).result()
    } catch (err) {
      console.warn(`[TemporalBridge] ${wfId} finished, but its verdict on the workload could not be read, so the app is taken as running: ${(err as Error).message}`)
    }
    const unhealthy = textAt(verdict, 'workload') === 'unhealthy'
    return {
      status: unhealthy ? 'unhealthy' : 'running',
      meta: { ...meta, healthReason: unhealthy ? (textAt(verdict, 'workloadReason') ?? '') : '' },
    }
  }

  follow(
    wfId: string,
    action: FollowedAction,
    resourceId: string,
    resourceName: string,
    provider: ClusterMetadata['provider'] | '',
    meta?: TrackedDeployment
  ): Promise<void> {
    if (!wfId) return Promise.resolve()
    const already = this.following.get(wfId)
    if (already) return already
    const following = this.followUntilClosed(wfId, action, resourceId, resourceName, provider, meta)
      .catch((err: Error) => console.error(`[TemporalBridge] what ${wfId} ended as could not be recorded: ${err.message}`))
      .finally(() => this.following.delete(wfId))
    this.following.set(wfId, following)
    return following
  }

  private followRecord(followed: FollowedRecord): void {
    const action = followedAction(followed)
    const wfId = followed.record.temporalWorkflowId
    if (!action || !wfId) return
    if (followed.kind === 'cluster') void this.follow(wfId, action, followed.record.id, followed.record.name, followed.record.provider)
    else if (followed.kind === 'deployment') void this.follow(wfId, action, followed.record.id, followed.record.name, '', followed.record)
    else void this.follow(wfId, action, followed.record.id, followed.record.projectId, '')
  }

  private async followUntilClosed(
    wfId: string,
    action: FollowedAction,
    resourceId: string,
    resourceName: string,
    provider: ClusterMetadata['provider'] | '',
    meta?: TrackedDeployment
  ): Promise<void> {
    const again = reopening()
    for (;;) {
      let closed: ClosedAs
      try {
        closed = await closedAs(this.client.workflow.getHandle(wfId))
      } catch (err) {
        console.warn(`[TemporalBridge] lost ${wfId} while following it (${(err as Error).message}); following it again in ${again.seconds} s`)
        await again.after()
        continue
      }
      if (closed === 'RUNNING') continue
      if (closed === 'NOT_FOUND') console.warn(`[TemporalBridge] ${action} ${wfId} of ${resourceId} is not in Temporal, so it is taken as failed`)
      await this.settle(wfId, action, resourceId, resourceName, provider, meta, closed === 'COMPLETED' || closed === 'TERMINATED' || closed === 'CANCELLED' ? closed : 'FAILED')
      return
    }
  }

  private async settle(
    wfId: string,
    action: FollowedAction,
    resourceId: string,
    resourceName: string,
    provider: ClusterMetadata['provider'] | '',
    meta: TrackedDeployment | undefined,
    name: 'COMPLETED' | 'FAILED' | 'TERMINATED' | 'CANCELLED',
  ): Promise<void> {
    const deployment = (): TrackedDeployment => {
      if (!meta) throw new Error(`${action} ${wfId} of ${resourceId} is followed without its deployment`)
      return meta
    }
    const applied = async () => this.appliedOutcome(wfId, deployment())
    let kubeconfig: string | undefined
    if (name === 'COMPLETED' && action === 'cluster-provision') {
      kubeconfig = await this.recordProvisioned(wfId, { id: resourceId, name: resourceName, provider })
    }

    let pipelineImageTag: string | undefined
    if (name === 'COMPLETED' && action === 'pipeline-run') {
      try {
        pipelineImageTag = (await this.client.workflow.getHandle<typeof executePipelineRunWorkflow>(wfId).result()).imageTag
      } catch (err) {
        console.error(`[TemporalBridge] Build ${resourceId} finished, but its image could not be read: ${(err as Error).message}`)
      }
    }

    if (action === 'cluster-provision') {
      if (name === 'FAILED') {
        await updateUserStatus(this.db, resourceId, resourceName, provider, 'failed', kubeconfig)
      } else if (name === 'TERMINATED' || name === 'CANCELLED') {
        await updateUserStatus(this.db, resourceId, resourceName, provider, 'destroyed')
      } else {
        await updateUserStatus(this.db, resourceId, resourceName, provider, 'healthy', kubeconfig)
      }
      if (this.io) this.io.emit('cluster-updated')
    } else if (action === 'cluster-destroy') {
      if (name === 'FAILED') {
        await updateUserStatus(this.db, resourceId, resourceName, provider, 'failed')
      } else {
        await updateUserStatus(this.db, resourceId, resourceName, provider, 'destroyed')
      }
      if (this.io) this.io.emit('cluster-updated')
    } else if (action === 'app-deploy') {
      if (name === 'FAILED') {
        await updateDeploymentStatus(this.db, resourceId, deployment(), 'failed', meta?.storage)
      } else if (name === 'TERMINATED' || name === 'CANCELLED') {
        await updateDeploymentStatus(this.db, resourceId, deployment(), 'failed', meta?.storage)
      } else if (name === 'COMPLETED') {
        const done = await applied()
        await updateDeploymentStatus(this.db, resourceId, done.meta, done.status, meta?.storage)
        if (done.status === 'running') {
          await maybeSetDefaultModel(this.db, resourceId, done.meta.ownerId, done.meta.appType)
        }
      }
      if (this.io) this.io.emit('deployment-updated')
    } else if (action === 'app-destroy') {
      if (name === 'FAILED') {
        await updateDeploymentStatus(this.db, resourceId, deployment(), 'failed', meta?.storage)
      } else if (name === 'TERMINATED' || name === 'CANCELLED' || name === 'COMPLETED') {
        await this.db.infrastructure.deleteDeployment(resourceId)
      }
      if (this.io) this.io.emit('deployment-updated')
    } else if (action === 'app-resize') {
      const newStorage = { ...meta?.storage, ...meta?.newStorage }
      if (name === 'FAILED') {
        await updateDeploymentStatus(this.db, resourceId, deployment(), 'failed', meta?.storage)
      } else if (name === 'TERMINATED' || name === 'CANCELLED') {
        await updateDeploymentStatus(this.db, resourceId, deployment(), 'failed', meta?.storage)
      } else if (name === 'COMPLETED') {
        const done = await applied()
        await updateDeploymentStatus(this.db, resourceId, done.meta, done.status, newStorage)
      }
      if (this.io) this.io.emit('deployment-updated')
    } else if (action === 'app-sync-config') {
      if (name === 'FAILED' || name === 'TERMINATED' || name === 'CANCELLED') {
        await updateDeploymentStatus(this.db, resourceId, deployment(), 'failed', meta?.storage)
      } else if (name === 'COMPLETED') {
        const done = await applied()
        await updateDeploymentStatus(this.db, resourceId, done.meta, done.status, meta?.storage)
      }
      if (this.io) this.io.emit('deployment-updated')
    } else if (action === 'pipeline-run') {
      if (name === 'FAILED' || name === 'TERMINATED' || name === 'CANCELLED') {
        await updatePipelineRunStatus(this.db, resourceId, 'failed', { errorMessage: `Workflow ${name}` })
      } else if (name === 'COMPLETED') {
        await updatePipelineRunStatus(this.db, resourceId, 'succeeded', pipelineImageTag !== undefined ? { imageTag: pipelineImageTag } : {})
        try {
          const [projects, runs] = await Promise.all([this.db.projects.getProjects(), this.db.releases.getPipelineRuns()])
          const run = runs.find((r) => r.id === resourceId)
          const project = run && projects.find((p) => p.id === run.projectId)
          const released = project && run && this.onBuilt ? await this.onBuilt(project, run) : false
          if (!released && project?.autoDeployOnBuild && run) {
            const since = deploymentForProject(project, await this.db.infrastructure.getDeployments())?.gitappImageTag?.split(':').pop()
            const decision = since && this.decideRelease ? await this.decideRelease(project, since, run.commitSha) : { release: true as const }
            if (decision.release) await this.promoteProjectBuild(project, run)
            else await this.db.releases.savePipelineRunInfo({ id: run.id, releaseSkipped: decision.reason })
          }
        } catch (err) {
          console.error(`[TemporalBridge] Auto-deploy-on-build failed for pipeline run ${resourceId}: ${(err as Error).message}`)
        }
      }
      if (this.io) this.io.emit('pipeline-run-updated')
    }
  }

  async adoptPlan(ownerId: string, proposalId: string): Promise<string | undefined> {
    if (!this.client) return undefined
    const workflowId = `adopt-plan-${proposalId}`
    await this.client.workflow.start(AdoptPlanWorkflow, {
      workflowId,
      taskQueue: process.env.TEMPORAL_ENGINE_TASK_QUEUE || DEFAULT_ENGINE_TASK_QUEUE,
      args: [{ ownerId, proposalId }],
      ...startedFor(ownerId),
      workflowIdReusePolicy: 'ALLOW_DUPLICATE',
    })
    return workflowId
  }

  async startActiveWorkflowRecovery(): Promise<void> {
    if (!this.client) {
      try {
        this.client = await getDefaultClient(undefined, this.seams.connect)
      } catch (err) {
        console.warn(`[TemporalBridge] Skipping recovery, Temporal client not ready: ${(err as Error).message}`)
        return
      }
    }

    await this.followWork()
    this.startReconciliationLoop()
  }

  async followWork(): Promise<void> {
    if (this.watching.length > 0) return
    this.watching = [
      this.db.infrastructure.watchFollowed((followed) => this.followRecord(followed)),
      this.db.releases.watchLiveRuns((record) => this.followRecord({ kind: 'pipeline-run', record })),
    ]
    await Promise.all(this.watching.map((watching) => watching.ready))
    for (const record of await this.db.infrastructure.getClusters()) this.followRecord({ kind: 'cluster', record })
    for (const record of await this.db.infrastructure.getDeployments()) this.followRecord({ kind: 'deployment', record })
    for (const record of await this.db.releases.getPipelineRuns()) this.followRecord({ kind: 'pipeline-run', record })
  }

  async checkApps(): Promise<void> {
    const deployments = await this.db.infrastructure.getDeployments()

    const access = this.clustersForConsolidation().access
    const reaches = new Map<string, Reach | undefined>()
    const reachOf = async (clusterId: string): Promise<Reach | undefined> => {
      if (reaches.has(clusterId)) return reaches.get(clusterId)
      let reach: Reach | undefined
      try {
        reach = await access.reach(clusterId)
      } catch (err) {
        console.warn(`[Reconcile] the apps on cluster ${clusterId} are not checked this pass, since it cannot be reached: ${(err as Error).message}`)
      }
      reaches.set(clusterId, reach)
      return reach
    }

    const namespaces = new Map<string, Map<string, unknown>>()
    const namespacesOn = async (reach: Reach): Promise<Map<string, unknown>> => {
      const known = namespaces.get(reach.clusterId)
      if (known) return known
      const found = namespacesByName(await access.kubectl(reach, ['get', 'namespaces', '-o', 'json']))
      namespaces.set(reach.clusterId, found)
      return found
    }
    const tell = async (dep: DeploymentMetadata, health: DeploymentHealth): Promise<void> => {
      await this.db.infrastructure.patchDeploymentHealth(dep.id, health)
      if (this.io) this.io.emit('deployment-updated')
    }

    for (const dep of deployments) {
      if (dep.status !== 'running' && dep.status !== 'unhealthy' && dep.status !== 'destroying') continue
      try {
        const reach = await reachOf(dep.clusterId)
        if (!reach) continue
        const namespace = (await namespacesOn(reach)).get(namespaceOf(dep))
        if (dep.status === 'destroying') {
          const hold = namespace ? removalHoldOf(namespace) : undefined
          if ((hold ?? '') !== (dep.healthReason ?? '')) await tell(dep, { healthReason: hold })
          continue
        }
        if (!namespace) {
          const missing = missingNamespaceReason(namespaceOf(dep))
          if (dep.status !== 'unhealthy' || dep.healthReason !== missing) await tell(dep, { status: 'unhealthy', healthReason: missing })
          continue
        }
        const raw = await access.kubectl(reach, ['get', 'pods', '-n', namespaceOf(dep), '-o', 'json'])
        const { health, reason } = assessWorkload(JSON.parse(raw) as unknown)

        let serviceReason = ''
        if (health === 'healthy' && looksLikeMcp(dep) && dep.ownerId) {
          try {
            const verdict = healthFromProbe(await this.mcpProbes(namespaceOfDeployment(dep)))
            if (verdict) serviceReason = verdict.reason
          } catch (err) {
            console.warn(`[Reconcile] ${dep.name}'s MCP server could not be asked how it is, so only its pods are judged: ${(err as Error).message}`)
          }
        }

        const effective = serviceReason ? 'unhealthy' as const : health
        const next = reconciledStatus(dep.status, effective)
        if (next) {
          console.warn(`[Reconcile] ${dep.name} is ${dep.status} but the workload is ${effective}${(serviceReason || reason) ? ` (${serviceReason || reason})` : ''} — marking ${next}`)
          await tell(dep, { status: next, healthReason: serviceReason || reason })
        }
      } catch (err) {
        console.warn(`[Reconcile] ${dep.name} is not checked this pass: ${(err as Error).message}`)
      }
    }
  }

  private startReconciliationLoop(): void {
    const reconcile = async () => {
      if (!this.client) return
      try {
        for (const cluster of await this.db.infrastructure.getClusters()) {
          if (cluster.status !== 'provisioning' || !cluster.lastLogPath) continue
          const progress = inferProgressFromLog(cluster.lastLogPath)
          if (progress) await this.db.infrastructure.updateClusterProgress(cluster.id, progress)
        }

        await this.checkApps()
      } catch (err) {
        console.warn(`[Reconcile] Error: ${(err as Error).message}`)
      }

    }

    let consolidating = false
    const consolidate = async () => {
      if (consolidating) return
      consolidating = true
      try {
        const owners = [...new Set((await this.db.memory.getMemories()).map((memory) => memory.ownerId))]
        for (const ownerId of owners) {
          const ends = await corpusEndpointsWith(webToolsDepsFrom(this.db.infrastructure, this.clustersForConsolidation(), sharedClusterProxy()), ownerId).catch(ignore('an owner with no search service has their memories consolidated without an index'))
          const report = await consolidateMemories({
            db: this.db,
            ownerId,
            ...(ends ? {
              index: (items) => indexMemories(ends, items),
              similar: async (ids: string[]) => {
                const out = new Map<string, { id: string; score: number }[]>()
                for (const id of ids) {
                  out.set(id, await similarTo(ends, id, { ownerId }).catch(ignore('a memory the index cannot compare is left apart this pass and compared on the next')) ?? [])
                }
                return out
              },
            } : {}),
          })

          if (report.deduped || report.promoted || report.decayed) {
            console.log(`[Consolidate] ${ownerId}: ${report.live} live memories`
              + ` (deduped ${report.deduped}, promoted ${report.promoted}, decayed ${report.decayed},`
              + ` indexed ${report.indexed})`)
          }
          this.lastConsolidation = report
        }
      } catch (err) {
        console.warn(`[Consolidate] pass failed: ${(err as Error).message}`)
      } finally {
        consolidating = false
      }
    }

    for (const [pass, every] of [[reconcile, RECONCILE_INTERVAL], [consolidate, CONSOLIDATE_INTERVAL]] as const) {
      void pass()
      setInterval(() => { void pass() }, every)
    }
  }

  async stopIfRunning(wfId: string, reason: string): Promise<boolean> {
    if (!this.client) return false
    return (await stopIfRunning(this.client.workflow.getHandle(wfId), reason)) !== 'not-running'
  }

  async cancelWorkflow(workflowId: string): Promise<'cancelled' | 'not-running' | 'unreachable'> {
    if (!this.isReady()) return 'unreachable';
    const handle = this.client.workflow.getHandle(workflowId);
    const status = await handle.describe().then((found) => found.status.name, (err: unknown) => {
      if (/not\s*found/i.test(String((err as Error)?.message ?? err))) return 'NOT_FOUND';
      throw err;
    });
    if (status !== 'RUNNING') return 'not-running';
    await handle.cancel();
    return 'cancelled';
  }

  async terminateWorkflow(wfId: string, reason = 'User aborted operation'): Promise<boolean> {
    try {
      const handle = this.client.workflow.getHandle(wfId);
      await handle.terminate(reason);
      console.log(`[TemporalBridge] Terminated workflow ${wfId}: ${reason}`);
      return true;
    } catch (err) {
      console.warn(`[TemporalBridge] Failed to terminate workflow ${wfId}: ${(err as Error).message}`);
      return false;
    }
  }

  private async resolveHetznerToken(userId?: string): Promise<string | undefined> {
    let userCreds: CloudCredentials | undefined
    let asOperator = !userId
    if (userId) {
      const user = await this.db.accounts.getUserById(userId)
      asOperator = usesOperatorCredentials(user, this.claims)
      const enc = user?.credentials?.hetzner?.token
      if (enc) {
        try {
          userCreds = { hetzner: { token: decryptValue(enc, this.masterKey) } }
        } catch (failure) {
          ignore('a stored Hetzner token that can no longer be decrypted counts as none, so provisioning asks for one')(failure)
        }
      }
    }
    return resolveCloudCredentials('hetzner', userCreds, asOperator).env.HCLOUD_TOKEN
  }

  private async resolveDoToken(userId?: string): Promise<string | undefined> {
    let userCreds: CloudCredentials | undefined
    let asOperator = !userId
    if (userId) {
      const user = await this.db.accounts.getUserById(userId)
      asOperator = usesOperatorCredentials(user, this.claims)
      const enc = user?.credentials?.do?.token
      if (enc) {
        try {
          userCreds = { do: { token: decryptValue(enc, this.masterKey) } }
        } catch (failure) {
          ignore('a stored DigitalOcean token that can no longer be decrypted counts as none, so provisioning asks for one')(failure)
        }
      }
    }
    return resolveCloudCredentials('do', userCreds, asOperator).env.DIGITALOCEAN_TOKEN
  }

  async provision(
    clusterName: string,
    provider: ClusterMetadata['provider'],
    userId: string,
    hetzner?: { serverType?: string; location?: string; image?: string },
  ): Promise<ResourceDeal> {
    const wfId = `cluster-provision-${clusterName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const logFileName = `${Date.now()}-${Math.random().toString(36).slice(2)}-A1.log`
    const absoluteLogPath = path.join(LOG_DIR, logFileName)
    const keys = mockableProvider(provider)
      ? (await new CredentialService(this.db, this.masterKey, this.claims).resolveCredentials(userId, provider)).mode
      : 'user'
    const refused = provisionRefusal(provider, keys, process.env)
    if (refused) throw new ProvisionRefused(refused)
    const hcloudToken = provider === 'hetzner' ? await this.resolveHetznerToken(userId) : undefined
    if (provider === 'hetzner' && !hcloudToken) {
      throw new ProvisionRefused('No Hetzner Cloud API token configured — add one under Cloud providers first')
    }
    const doToken = provider === 'do' ? await this.resolveDoToken(userId) : undefined
    if (provider === 'do' && !doToken) {
      throw new ProvisionRefused('No DigitalOcean API token configured — add one under Cloud providers first')
    }
    const createsVm = provider === 'hetzner' || provider === 'do'

    const vmKeypair = createsVm
      ? await (this.seams.generateKeypair ?? generateSshKeypair)(`provisioning-${clusterName}`)
      : undefined

    const meshLoginServer = process.env.MESH_LOGIN_SERVER
    let meshPreAuthKey: string | undefined
    if (createsVm && meshLoginServer && this.headscale) {
      try {
        meshPreAuthKey = (await this.headscale.createPreAuthKey(userId, { reusable: true, expirySeconds: 2 * 60 * 60 })).key
      } catch (err) {
        console.error(`[TemporalBridge] Could not mint a mesh pre-auth key for "${clusterName}" — provisioning without mesh join: ${(err as Error).message}`)
      }
    }

    const activityArgs = {
      name: clusterName,
      provider,
      logFile: absoluteLogPath,
      ...(hcloudToken ? { hcloudToken } : {}),
      ...(hetzner?.serverType ? { hetznerServerType: hetzner.serverType } : {}),
      ...(hetzner?.location ? { hetznerLocation: hetzner.location } : {}),
      ...(hetzner?.image ? { hetznerImage: hetzner.image } : {}),
      ...(vmKeypair && provider === 'hetzner' ? {
        hetznerSshPrivateKey: vmKeypair.privateKey,
        hetznerSshPublicKey: vmKeypair.publicKey,
      } : {}),
      ...(doToken ? { doToken } : {}),
      ...(hetzner?.serverType && provider === 'do' ? { doSize: hetzner.serverType } : {}),
      ...(hetzner?.location && provider === 'do' ? { doRegion: hetzner.location } : {}),
      ...(hetzner?.image && provider === 'do' ? { doImage: hetzner.image } : {}),
      ...(vmKeypair && provider === 'do' ? {
        doSshPrivateKey: vmKeypair.privateKey,
        doSshPublicKey: vmKeypair.publicKey,
      } : {}),
      ...(meshLoginServer && meshPreAuthKey ? { meshLoginServer, meshPreAuthKey } : {}),
    }

    const savedCluster = await this.db.infrastructure.saveClusterInfo({
      name: clusterName,
      provider,
      status: 'provisioning',
      temporalWorkflowId: '',
      lastLogPath: absoluteLogPath,
      createdAt: new Date().toISOString(),
      ownerId: userId,
      ...(hetzner?.serverType ? { hetznerServerType: hetzner.serverType } : {}),
      ...(hetzner?.location ? { hetznerLocation: hetzner.location } : {}),
      ...(hetzner?.image ? { hetznerImage: hetzner.image } : {}),
      ...(vmKeypair ? {
        remoteSshPrivateKeyEnc: encryptValue(vmKeypair.privateKey, this.masterKey),
      } : {}),
    })

    await this.client.workflow.start(ClusterProvisionWorkflow, {
      workflowId: wfId,
      taskQueue: HOST_QUEUE,
      args: [activityArgs],
      ...startedFor(userId ?? PLATFORM_OWNER),
    })

    void this.follow(wfId, 'cluster-provision', savedCluster.id, clusterName, provider)
    await this.db.infrastructure.saveClusterInfo({ id: savedCluster.id, temporalWorkflowId: wfId })

    return {
      id: wfId,
      resourceId: savedCluster.id,
      event: 'cluster-provision',
    }
  }

async destroyCluster(clusterId: string): Promise<WorkflowDeal> {
  const clusters = await this.db.infrastructure.getClusters()
  const [cluster] = clusters.filter((c: ClusterMetadata) => c.id === clusterId)
  if (!cluster) throw new Error('ClusterMetadata not found')

  if (cluster.provider === 'machine') {
    throw new Error(`"${cluster.name}" is a machine's own cluster: it goes when the machine is removed from My Machines`)
  }
  if (cluster.status === 'destroying') {
    throw new Error(`Cluster "${cluster.name}" is already being destroyed`)
  }

    const logFileName = `${Date.now()}-destroy-${Math.random().toString(36).slice(2)}-B2.log`
    const absoluteLogPath = path.join(LOG_DIR, logFileName)
    const doToken = cluster.provider === 'do' ? await this.resolveDoToken(cluster.ownerId) : undefined
    const hcloudToken = cluster.provider === 'hetzner' ? await this.resolveHetznerToken(cluster.ownerId) : undefined
    if (cluster.provider === 'hetzner' && !hcloudToken) {
      throw new Error('No Hetzner Cloud API token configured — cannot destroy the VM without it')
    }
    const activityArgs = {
      name: cluster.name,
      provider: cluster.provider,
      logFile: absoluteLogPath,
      ...(cluster.gpuEnabled !== undefined ? { gpuEnabled: cluster.gpuEnabled } : {}),
      ...(hcloudToken ? { hcloudToken } : {}),
      ...(doToken ? { doToken } : {}),
      ...(cluster.doServerId ? { doServerId: cluster.doServerId } : {}),
      ...(cluster.hetznerServerId ? { hetznerServerId: cluster.hetznerServerId } : {}),
    }
    const wfId = `cluster-destroy-${cluster.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    await this.db.infrastructure.saveClusterInfo({
      id: cluster.id,
      status: 'destroying',
      temporalWorkflowId: '',
      lastLogPath: absoluteLogPath,
    })

    await this.client.workflow.start(executeDestroyClusterWorkflow, {
      workflowId: wfId,
      taskQueue: HOST_QUEUE,
      args: [activityArgs],
      ...startedFor(cluster.ownerId ?? PLATFORM_OWNER),
    })

    void this.follow(wfId, 'cluster-destroy', cluster.id, cluster.name, cluster.provider)
    await this.db.infrastructure.saveClusterInfo({ id: cluster.id, temporalWorkflowId: wfId })

    return {
      id: wfId,
      event: 'cluster-destroy',
    }
  }


  async deployApp(config: Record<string, unknown>, userId?: string): Promise<ResourceDeal> {
    const { workflowId, deployment } = await startAppDeploy(this.appDeployDeps(), deployRequestOf(config), userId)
    void this.follow(workflowId, 'app-deploy', deployment.id, deployment.name, '', deployment)
    return {
      id: workflowId,
      resourceId: deployment.id,
      event: 'app-deploy',
    }
  }

  appDeployDeps(): AppDeployDeps {
    return { db: this.db, client: () => this.client, masterKey: this.masterKey, clusterById: (id) => this.getClusterById(id), logDir: LOG_DIR, claims: this.claims }
  }

  async destroyApp(deploymentId: string): Promise<WorkflowDeal> {
    const deployments = await this.db.infrastructure.getDeployments()
    const [dep] = deployments.filter((d: DeploymentMetadata) => d.id === deploymentId)
    if (!dep) throw new Error('DeploymentMetadata not found (destroyApp)')

    const cluster = await this.getClusterById(dep.clusterId)
    const wfId = destroyAppWorkflowId(dep, Date.now(), Math.random().toString(36).slice(2, 8))
    const logFileName = `${Date.now()}-${Math.random().toString(36).slice(2)}-D4.log`
    const absoluteLogPath = path.join(LOG_DIR, logFileName)

    const activityArgs = destroyAppArgs(dep, cluster, absoluteLogPath)

    await this.db.infrastructure.saveDeploymentInfo({
      id: dep.id,
      status: 'destroying',
      temporalWorkflowId: '',
      lastLogPath: absoluteLogPath,
    })

    await this.client.workflow.start(executeDestroyAppWorkflow, {
      workflowId: wfId,
      taskQueue: CLUSTER_QUEUE,
      args: [activityArgs],
      ...startedFor(dep.ownerId ?? PLATFORM_OWNER),
    })

    void this.follow(wfId, 'app-destroy', dep.id, dep.name, '', dep)
    await this.db.infrastructure.saveDeploymentInfo({ id: dep.id, temporalWorkflowId: wfId })

    return {
      id: wfId,
      event: 'app-destroy',
    }
  }

  async resizeDisk(deploymentId: string, storage: Record<string, string>): Promise<WorkflowDeal> {
    const deployments = await this.db.infrastructure.getDeployments()
    const [dep] = deployments.filter((d: DeploymentMetadata) => d.id === deploymentId)
    if (!dep) throw new Error('DeploymentMetadata not found (resizeDisk)')

    const cluster = await this.getClusterById(dep.clusterId)
    const wfId = `resize-disk-${dep.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const logFileName = `${Date.now()}-${Math.random().toString(36).slice(2)}-E5.log`
    const absoluteLogPath = path.join(LOG_DIR, logFileName)

    const activityArgs = {
      name: dep.name,
      namespace: dep.namespace,
      clusterId: dep.clusterId,
      clusterName: cluster?.name || 'unknown',
      provider: cluster?.provider || 'k3d',
      strategy: dep.strategy || 'helm',
      appType: dep.appType || 'odoo',
      storage,
      logFile: absoluteLogPath,
      deploymentId: dep.deploymentId || 'default',
    }

    await this.db.infrastructure.saveDeploymentInfo({
      ...dep,
      storage: { ...dep.storage, ...storage },
      status: 'deploying',
      healthReason: '',
      temporalWorkflowId: '',
      lastLogPath: absoluteLogPath,
    })

    await this.client.workflow.start(executeResizeDiskWorkflow, {
      workflowId: wfId,
      taskQueue: CLUSTER_QUEUE,
      args: [activityArgs],
      ...startedFor(dep.ownerId ?? PLATFORM_OWNER),
    })

    void this.follow(wfId, 'app-resize', dep.id, dep.name, '', { ...dep, newStorage: storage })
    await this.db.infrastructure.saveDeploymentInfo({ id: dep.id, temporalWorkflowId: wfId })

    return {
      id: wfId,
      event: 'disk-resize',
    }
  }

  async syncConfig(deploymentId: string): Promise<WorkflowDeal> {
    const deployments = await this.db.infrastructure.getDeployments()
    let [dep] = deployments.filter((d: DeploymentMetadata) => d.id === deploymentId)
    if (!dep) throw new Error('DeploymentMetadata not found (syncConfig)')
    dep = resolveVllmDefaults(dep)
    dep = resolveTabbyDefaults(dep)
    dep = resolveCrawl4aiDefaults(dep)
    dep = resolveSearxngDefaults(dep)
    dep = resolveNextcloudDefaults(resolveMinioDefaults(dep))
    dep = resolveHermesDefaults(dep)
    dep = resolveQdrantDefaults(dep)
    dep = resolveQuickwitDefaults(dep, deployments)
    dep = resolveAppSettingsDefaults(dep)

    const openaiApiBaseUrl = resolveOpenaiApiBaseUrl(dep, deployments);

    const cluster = await this.getClusterById(dep.clusterId)
    const wfId = `sync-config-${dep.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const logFileName = `${Date.now()}-${Math.random().toString(36).slice(2)}-G7.log`
    const absoluteLogPath = path.join(LOG_DIR, logFileName)

    const activityArgs = {
      name: dep.name,
      namespace: dep.namespace,
      clusterId: dep.clusterId,
      clusterName: cluster?.name || 'unknown',
      provider: cluster?.provider || 'k3d',
      strategy: dep.strategy || 'helm',
      appType: dep.appType || 'odoo',
      webRepo: dep.webRepo,
      webTag: dep.webTag,
      dbRepo: dep.dbRepo,
      dbTag: dep.dbTag,
      storage: dep.storage || {},
      logFile: absoluteLogPath,
      deploymentId: dep.deploymentId || 'default',
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

    await this.db.infrastructure.saveDeploymentInfo({
      id: dep.id,
      status: 'deploying',
      healthReason: '',
      temporalWorkflowId: '',
      lastLogPath: absoluteLogPath,
    })

    await this.client.workflow.start(executeSyncConfigWorkflow, {
      workflowId: wfId,
      taskQueue: CLUSTER_QUEUE,
      args: [activityArgs],
      ...startedFor(dep.ownerId ?? PLATFORM_OWNER),
    })

    void this.follow(wfId, 'app-sync-config', dep.id, dep.name, '', dep)
    await this.db.infrastructure.saveDeploymentInfo({ id: dep.id, temporalWorkflowId: wfId })

    return {
      id: wfId,
      event: 'config-sync',
    }
  }

  async updateConfigAndSync(deploymentId: string, patch: Partial<DeploymentMetadata>): Promise<WorkflowDeal> {
    const deployments = await this.db.infrastructure.getDeployments()
    const dep = deployments.find((d: DeploymentMetadata) => d.id === deploymentId)
    if (!dep) throw new Error('DeploymentMetadata not found (updateConfigAndSync)')

    const merged: DeploymentMetadata = { ...dep, ...patch }
    for (const field of DEEP_MERGE_FIELDS) {
      const incoming = patch[field]
      if (incoming) {
        merged[field] = { ...(dep[field] ?? {}), ...incoming }
      }
    }
    await this.db.infrastructure.saveDeploymentInfo(merged)

    return this.syncConfig(deploymentId)
  }

  private reachable(): Client {
    if (!this.isReady()) throw Object.assign(new Error('Temporal is not reachable'), { status: 503 })
    return this.client
  }

  async listWorkflows(query?: string, pageSize?: number): Promise<WorkflowSummary[]> {
    const iter = this.reachable().workflow.list({ ...(query ? { query } : {}), pageSize: pageSize || 50 })
    const workflows: WorkflowSummary[] = []
    for await (const wf of iter) workflows.push(summaryOf(wf))
    return workflows
  }

  async countWorkflows(query?: string): Promise<number> {
    return (await this.reachable().workflow.count(query)).count
  }

  async describeWorkflow(workflowId: string): Promise<WorkflowSummary | null> {
    try {
      return summaryOf(await this.reachable().workflow.getHandle(workflowId).describe())
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) return null
      throw err
    }
  }

  async getWorkflowHistory(workflowId: string): Promise<unknown[] | null> {
    try {
      const history = await this.reachable().workflow.getHandle(workflowId).fetchHistory()
      return (history.events ?? []).map((e) => ({
        id: e.eventId,
        type: e.eventType,
        time: e.eventTime,
        attributes: attributesOf(e),
      }))
    } catch (err) {
      if (err instanceof WorkflowNotFoundError || (isGrpcServiceError(err) && err.code === GRPC_NOT_FOUND)) return null
      throw err
    }
  }

  async onClusterStatus(_query: string): Promise<ClusterMetadata[]> {
    return this.db.infrastructure.getClusters()
  }

  async onClusterStatusClearup(clusterId: string): Promise<void> {
    await this.db.infrastructure.deleteDeploymentsOfCluster(clusterId)
  }

  async runPipeline(project: ProjectMetadata, commitSha: string, ref: string): Promise<ResourceDeal | NothingToBuild> {
    if (!project.giteaOwner || !project.giteaRepo) {
      throw new Error(`Project ${project.id} has no repository to run a pipeline for.`)
    }
    if (!isCommitSha(commitSha)) throw new Error(`"${commitSha}" is not a commit to build`)
    const plan = this.planBuild ? await this.planBuild(project, commitSha) : undefined
    if (plan && !plan.build) {
      console.log(`[pipeline] ${project.name}: ${plan.reason}; no build recorded`)
      return { event: 'nothing-to-build', reason: plan.reason }
    }
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const wfId = `pipeline-run-${project.giteaRepo}-${runId}`
    const logFileName = `${Date.now()}-${Math.random().toString(36).slice(2)}-A1.log`
    const absoluteLogPath = path.join(LOG_DIR, logFileName)

    const activityArgs = {
      projectId: project.id,
      giteaOwner: project.giteaOwner,
      giteaRepo: project.giteaRepo,
      commitSha,
      ref,
      logFile: absoluteLogPath,
      runId,
    }

    await this.db.releases.savePipelineRunInfo({
      id: runId,
      projectId: project.id,
      commitSha,
      ref,
      status: 'queued',
      logFile: absoluteLogPath,
      temporalWorkflowId: '',
      startedAt: new Date().toISOString(),
    })
    await this.db.projects.saveProjectInfo({ ...project, lastBuildStatus: 'queued' })

    await this.client.workflow.start(executePipelineRunWorkflow, {
      workflowId: wfId,
      taskQueue: CLUSTER_QUEUE,
      args: [activityArgs],
      ...startedFor(project.ownerId ?? PLATFORM_OWNER),
    })

    void this.follow(wfId, 'pipeline-run', runId, project.giteaRepo, '')
    await this.db.releases.savePipelineRunInfo({ id: runId, temporalWorkflowId: wfId })
    if (this.io) this.io.emit('pipeline-run-updated')

    return { id: wfId, resourceId: runId, event: 'pipeline-run' }
  }

  async startIngest(args: {
    ownerId: string;
    url: string;
    projectId?: string | undefined;
    maxDepth?: number | undefined;
    maxPages?: number | undefined;
    domains?: string[] | undefined;
    keywords?: string[] | undefined;
  }): Promise<{ workflowId: string }> {
    const workflowId = `ingest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const { ownerId, url, ...limits } = args
    await this.client.workflow.start(executeIngestWorkflow, {
      taskQueue: 'host-ops-queue',
      workflowId,
      args: [{ ownerId, url, ...definedFields(limits) }],
      ...startedFor(args.ownerId),
    })
    return { workflowId }
  }

  async ingestStatus(workflowId: string): Promise<{ state: string; receipt?: unknown; error?: string }> {
    try {
      const name = (await this.client.workflow.getHandle(workflowId).describe()).status.name
      if (name === 'RUNNING') return { state: 'running' }
      if (name === 'COMPLETED') {
        const receipt: unknown = await this.client.workflow.getHandle<typeof executeIngestWorkflow>(workflowId).result()
        return { state: 'completed', receipt }
      }
      return { state: (name ?? 'unknown').toLowerCase() }
    } catch (err) {
      return { state: 'unknown', error: (err as Error | undefined)?.message ?? String(err) }
    }
  }

  async promoteProjectBuild(project: ProjectMetadata, run: PipelineRunMetadata, userId?: string): Promise<ResourceDeal> {
    const secrets = await this.ensureSecrets?.(project)
    if (secrets?.waiting.length) throw new Error(`waiting for the person to enter ${secrets.waiting.join(', ')}`)
    const { workflowId, deployment } = await deployProjectBuild(this.appDeployDeps(), project, run, userId)
    void this.follow(workflowId, 'app-deploy', deployment.id, deployment.name, '', deployment)
    return { id: workflowId, resourceId: deployment.id, event: 'app-deploy' }
  }
}
