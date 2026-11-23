import { withWorkFor } from '@koala/engine-core/work-for'
import path from 'path';
import { isCommitSha, type BuildPlan } from '../../releases/index.js'
import {
  cancelIfRunning, getTemporalClient, closedWith, reopening, thrownFor, type ClosedAs, type Watching, type SecretKey, type Database, type DependencyReporter,
  type ClusterMetadata, type DeploymentMetadata, type ProjectMetadata,
  type PipelineRunMetadata, PLATFORM_OWNER, ownerIn, startedFor,
} from '../../platform/index.js'
import {
  looksLikeMcp, cachedProbes, mcpReachFrom, type McpProbe, type WaitingAsk,
} from '../../engine/index.js'
import type { DeploymentHealth } from '../store.js'
import { missingNamespaceReason, namespacesByName, namespaceOf, removalHoldOf } from '../lib/app-namespace.js'
import { healthFromProbe } from '../lib/service-health.js'
import { followedAction, type FollowedAction, type FollowedRecord } from '../lib/followed-work.js'
import { tellDeploymentChanged } from './deployment-told.js'
import { fileURLToPath } from 'url';
import { isGrpcServiceError, WorkflowNotFoundError, type Client, type WorkflowExecutionInfo } from '@temporalio/client'
import type { temporal } from '@temporalio/proto'
import { ignore } from '@koala/engine-core/failures'
import { at, isOff, listAt, textAt, type MemoryIndexReach, type Off } from '../../platform/index.js'
import { appSettingsOf, definedFields, deployRequestOf } from '../lib/deploy-request.js'
import { AdoptPlanWorkflow } from '../../workflows/AdoptPlanWorkflow.js'
import { executeIngestWorkflow } from '../../workflows/IngestWorkflow.js'

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { DEFAULT_ENGINE_TASK_QUEUE, type GroveRunResult } from '../../engine-host/temporal/contracts.js'

export type GroveRunStatus =
  | { state: 'none' | 'unavailable' }
  | { state: 'running'; startedAt: string; turnId?: string | undefined; asking?: WaitingAsk[] | undefined }
  | { state: 'finished'; startedAt: string; closedAt?: string; result: GroveRunResult; turnId?: string | undefined }
  | { state: 'failed'; startedAt: string; closedAt?: string; reason: string; turnId?: string | undefined }
import { deploymentForProject, projectOfWork } from '../../projects/index.js'
import { destroyAppArgs, destroyAppWorkflowId } from '../lib/app-destroy.js'
import { AppStackUnknown, appStackOf } from '../lib/deployment-id.js'
import { keepEveryOwner, type ConsolidationReport } from '../../memory/index.js'
import { assessWorkload, reconciledStatus } from '@koala/provision'
import type { Reach } from '../lib/cluster-places.js'
import { isModelKind } from '../../models/index.js'
import type { ToolCallParsers } from '../../models/index.js'
import { ClusterService } from './ClusterService.js'
import { deployProjectBuild, startAppDeploy, resolveOpenaiApiBaseUrl, servingArgsOf, type AppDeployDeps } from './AppDeploy.js'
import { executeDestroyAppWorkflow } from '../../workflows/DestroyAppWorkflow.js'
import { executeResizeDiskWorkflow } from '../../workflows/ResizeDiskWorkflow.js'
import { executeSyncConfigWorkflow } from '../../workflows/SyncConfigWorkflow.js'
import { executePipelineRunWorkflow } from '../../workflows/PipelineRunWorkflow.js'
import { resolveVllmDefaults, resolveTabbyDefaults, resolveCrawl4aiDefaults, resolveSearxngDefaults,
  resolveHermesDefaults, resolveMinioDefaults, resolveNextcloudDefaults } from '../lib/app-env.js'
import { resolveAppSettingsDefaults } from '../lib/app-schemas.js'
import type { Server as SocketServer } from 'socket.io'
import { QUEUES } from '../../platform/index.js';

const GRPC_NOT_FOUND = 5

const CLUSTER_QUEUE = QUEUES.cluster
const RECONCILE_INTERVAL = 30000

const CONSOLIDATE_INTERVAL = 1_800_000

const DEEP_MERGE_FIELDS = ['storage', 'appSettings'] as const


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
  failure: string | undefined = undefined,
): Promise<void> {
  const deployments = await db.infrastructure.getDeployments();
  const existing = deployments.find((d) => d.id === deploymentId);
  await db.infrastructure.saveDeploymentInfo({
    ...deployment,
    id: deploymentId,
    status,
    ...(status === 'failed' && failure ? { failure } : {}),
    ...(storage !== undefined ? { storage } : {}),
    ...(existing?.temporalWorkflowId !== undefined ? { temporalWorkflowId: existing.temporalWorkflowId } : {}),
    ...(existing?.lastLogPath !== undefined ? { lastLogPath: existing.lastLogPath } : {}),
    ...(existing?.deploymentId !== undefined ? { deploymentId: existing.deploymentId } : {}),
    ...(existing?.ownerId !== undefined ? { ownerId: existing.ownerId } : {}),
  })
  if (status === 'failed') return
  const saved = (await db.infrastructure.getDeployments()).find((d) => d.id === deploymentId)
  if (saved?.failure === undefined) return
  const { failure: _cleared, ...rest } = saved
  await db.infrastructure.saveDeployment(rest)
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

const appTypeOf = (dep: Pick<DeploymentMetadata, 'name' | 'appType'>): string => {
  if (!dep.appType) throw new AppStackUnknown(`${dep.name} records no app type, so Koala cannot tell how to apply it again`);
  return dep.appType;
};

export class TemporalBridge {
  db!: Database
  private mcpProbeCache: ((dep: DeploymentMetadata) => Promise<McpProbe>) | undefined
  io: SocketServer | undefined
  client!: Client
  masterKey: SecretKey
  private readonly following = new Map<string, Promise<void>>()
  private watching: Watching[] = []
  private reached!: () => void
  private neverReached!: (why: Error) => void
  private readonly reaching = new Promise<void>((reached, never) => { this.reached = reached; this.neverReached = never })
  clusterService?: ClusterService

  lastConsolidation?: ConsolidationReport

  constructor(
    db: Database,
    private readonly logDir: string,
    io?: SocketServer,
    masterKey?: SecretKey,
    clusterService?: ClusterService,
    private readonly seams: { connect?: TemporalConnect | undefined; dependencies?: DependencyReporter | undefined; toolCalling?: Pick<ToolCallParsers, 'decide'> | undefined; memoryIndex?: MemoryIndexReach | Off | undefined } = {},
  ) {
    this.db = db
    this.io = io
    this.masterKey = masterKey || ''
    if (clusterService !== undefined) this.clusterService = clusterService
    this.reaching.catch(ignore('a backend that stopped before it reached Temporal tells whoever waits on connected(), and nobody else'))
  }

  private clustersForConsolidation(): ClusterService {
    if (!this.clusterService) throw new Error('memories are consolidated through the cluster service, and this bridge was given none')
    return this.clusterService
  }

  private mcpProbes(dep: DeploymentMetadata): Promise<McpProbe> {
    this.mcpProbeCache ??= cachedProbes(mcpReachFrom({ access: this.clusterAccess(), clusterById: (id) => this.getClusterById(id) }).probe)
    return this.mcpProbeCache(dep)
  }

  private memoryIndex(): MemoryIndexReach {
    const index = this.seams.memoryIndex
    if (!index) throw new Error('memories are kept in the memory index, and this bridge was given none')
    if (isOff(index)) throw new Error(`memories cannot be kept here: ${index.off}`)
    return index
  }

  private toolCalling(): Pick<ToolCallParsers, 'decide'> {
    const toolCalling = this.seams.toolCalling
    if (!toolCalling) throw new Error('a vLLM app\'s tool calling is decided by the tool call parsers, and this bridge was given none')
    return toolCalling
  }

  private clusterAccess(): ClusterService['access'] {
    if (!this.clusterService) throw new Error('clusters are reached through the cluster service, and this bridge was given none')
    return this.clusterService.access
  }

  onBuilt?: (project: ProjectMetadata, run: PipelineRunMetadata) => Promise<boolean>

  ensureSecrets?: (project: ProjectMetadata) => Promise<{ waiting: string[] }>
  decideRelease?: (project: ProjectMetadata, since: string, commit: string) => Promise<{ release: true } | { release: false; reason: string }>
  planBuild?: (project: ProjectMetadata, commitSha: string) => Promise<BuildPlan>

  isReady(): boolean {
    return !!this.client
  }

  connected(): Promise<void> {
    return this.reaching
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
    if (this.clusterService?.isKoalasCluster(id)) return this.clusterService.ownCluster();
    const clusters = await this.db.infrastructure.getClusters();
    return clusters.find((c: ClusterMetadata) => c.id === id);
  }

  async start(address?: string): Promise<this> {
    const c = await getDefaultClient(address, this.seams.connect)
    this.client = c
    this.reached()
    return this
  }

  async stop(): Promise<void> {
    if (!this.client) this.neverReached(new Error('the backend stopped before it connected to Temporal, so nothing it was waiting to start will start'))
    await Promise.all(this.watching.splice(0).map((watching) => watching.close()))
    try {
      await this.client.connection.close()
    } catch (failure) {
      ignore('a connection to Temporal that is already closed has nothing left to close')(failure)
    }
  }

  private async resultOf<T>(wfId: string, what: string): Promise<T> {
    const again = reopening()
    let told: string | undefined
    for (;;) {
      try {
        return await this.client.workflow.getHandle(wfId).result() as T
      } catch (err) {
        if (err instanceof WorkflowNotFoundError) throw err
        const reason = (thrownFor(this.seams.dependencies, 'temporal', err) as Error).message
        if (reason !== told) console.warn(`[TemporalBridge] ${wfId} finished, but ${what} could not be read (${reason}); reading it again`)
        told = reason
        await again.after()
      }
    }
  }

  private async appliedOutcome(
    wfId: string,
    meta: DeploymentMetadata,
  ): Promise<{ status: 'running' | 'unhealthy'; meta: DeploymentMetadata }> {
    const verdict = await this.resultOf<unknown>(wfId, 'its verdict on the workload')
    const unhealthy = textAt(verdict, 'workload') === 'unhealthy'
    return {
      status: unhealthy ? 'unhealthy' : 'running',
      meta: { ...meta, healthReason: unhealthy ? (textAt(verdict, 'workloadReason') ?? '') : '', ...(Array.isArray(at(verdict, 'notes')) ? { deployNotes: listAt(verdict, 'notes').filter((line): line is string => typeof line === 'string') } : {}) },
    }
  }

  follow(
    wfId: string,
    action: FollowedAction,
    resourceId: string,
    resourceName: string,
    meta?: DeploymentMetadata
  ): Promise<void> {
    if (!wfId) return Promise.resolve()
    const already = this.following.get(wfId)
    if (already) return already
    const following = this.followUntilClosed(wfId, action, resourceId, resourceName, meta)
      .catch((err: Error) => console.error(`[TemporalBridge] what ${wfId} ended as could not be recorded: ${err.message}`))
      .finally(() => this.following.delete(wfId))
    this.following.set(wfId, following)
    return following
  }

  private followRecord(followed: FollowedRecord): void {
    const action = followedAction(followed)
    const wfId = followed.record.temporalWorkflowId
    if (!action || !wfId) return
    if (followed.kind === 'deployment') tellDeploymentChanged(this.io, followed.record.ownerId)
    if (followed.kind === 'deployment') void this.follow(wfId, action, followed.record.id, followed.record.name, followed.record)
    else void this.follow(wfId, action, followed.record.id, followed.record.projectId)
  }

  private async followUntilClosed(
    wfId: string,
    action: FollowedAction,
    resourceId: string,
    resourceName: string,
    meta?: DeploymentMetadata
  ): Promise<void> {
    const again = reopening()
    for (;;) {
      let closed: ClosedAs
      let why: string | undefined
      try {
        ({ as: closed, why } = await closedWith(this.client.workflow.getHandle(wfId)))
      } catch (err) {
        this.seams.dependencies?.failed('temporal', err)
        console.warn(`[TemporalBridge] lost ${wfId} while following it (${(err as Error).message}); following it again in ${again.seconds} s`)
        await again.after()
        continue
      }
      if (closed === 'RUNNING') continue
      if (closed === 'NOT_FOUND') console.warn(`[TemporalBridge] ${action} ${wfId} of ${resourceId} is not in Temporal, so it is taken as failed`)
      await this.settle(wfId, action, resourceId, resourceName, meta, closed === 'COMPLETED' || closed === 'TERMINATED' || closed === 'CANCELLED' ? closed : 'FAILED', why)
      return
    }
  }

  private async settle(
    wfId: string,
    action: FollowedAction,
    resourceId: string,
    resourceName: string,
    meta: DeploymentMetadata | undefined,
    name: 'COMPLETED' | 'FAILED' | 'TERMINATED' | 'CANCELLED',
    why?: string,
  ): Promise<void> {
    const failure = name === 'FAILED' ? (why ?? 'its workflow failed without saying why') : name === 'COMPLETED' ? undefined : `its workflow was ${name.toLowerCase()}`
    const deployment = (): DeploymentMetadata => {
      if (!meta) throw new Error(`${action} ${wfId} of ${resourceId} is followed without its deployment`)
      return meta
    }
    const applied = async () => this.appliedOutcome(wfId, deployment())
    const ownerId = meta?.ownerId
    let pipelineImageTag: string | undefined
    if (name === 'COMPLETED' && action === 'pipeline-run') {
      pipelineImageTag = (await this.resultOf<Awaited<ReturnType<typeof executePipelineRunWorkflow>>>(wfId, 'the image it built')).imageTag
    }

    if (action === 'app-deploy' || action === 'app-resize' || action === 'app-sync-config') {
      if (name === 'COMPLETED') {
        const done = await applied()
        const storage = action === 'app-resize' ? { ...meta?.storage, ...meta?.followedFor?.newStorage } : meta?.storage
        await updateDeploymentStatus(this.db, resourceId, done.meta, done.status, storage)
        if (action === 'app-deploy' && done.status === 'running') {
          await maybeSetDefaultModel(this.db, resourceId, done.meta.ownerId, done.meta.appType)
        }
      } else {
        await updateDeploymentStatus(this.db, resourceId, deployment(), 'failed', meta?.storage, failure)
      }
      tellDeploymentChanged(this.io, ownerId)
    } else if (action === 'app-destroy') {
      if (name === 'FAILED') {
        await updateDeploymentStatus(this.db, resourceId, deployment(), 'failed', meta?.storage, failure)
      } else if (name === 'TERMINATED' || name === 'CANCELLED' || name === 'COMPLETED') {
        await this.db.infrastructure.deleteDeployment(resourceId)
        await this.db.accounts.forgetDefaultModels([resourceId])
        if (this.io && ownerId) this.io.to(`user:${ownerId}`).emit('resource-destroyed', { id: resourceId, type: 'deployment', name: resourceName })
      }
      tellDeploymentChanged(this.io, ownerId)
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

  private forProject<T>(projectId: string | undefined, start: () => Promise<T>): Promise<T> {
    return withWorkFor({ project: projectId }, start)
  }

  async adoptPlan(ownerId: string, proposalId: string): Promise<string | undefined> {
    if (!this.client) return undefined
    const workflowId = `adopt-plan-${proposalId}`
    const proposal = await this.db.projects.getPlanProposal(ownerId, proposalId)
    const project = proposal ? await projectOfWork(this.db)(ownerId, { projectId: proposal.projectId, treeId: proposal.plan?.treeId, conversationId: proposal.conversationId }) : undefined
    const client = this.client
    await this.forProject(project, () => client.workflow.start(AdoptPlanWorkflow, {
      workflowId,
      taskQueue: DEFAULT_ENGINE_TASK_QUEUE,
      args: [{ ownerId, proposalId }],
      ...startedFor(ownerId),
      workflowIdReusePolicy: 'ALLOW_DUPLICATE',
    }))
    return workflowId
  }

  async startActiveWorkflowRecovery(): Promise<void> {
    this.client ??= await getDefaultClient(undefined, this.seams.connect)

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
      tellDeploymentChanged(this.io, dep.ownerId)
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
            const verdict = healthFromProbe(await this.mcpProbes(dep))
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
        await this.checkApps()
      } catch (err) {
        console.warn(`[Reconcile] Error: ${(err as Error).message}`)
      }

    }

    const consolidate = () => this.consolidateMemoryBank()

    for (const [pass, every] of [[reconcile, RECONCILE_INTERVAL], [consolidate, CONSOLIDATE_INTERVAL]] as const) {
      void pass()
      setInterval(() => { void pass() }, every)
    }
  }

  private consolidating = false

  async consolidateMemoryBank(): Promise<void> {
    if (this.consolidating) return
    this.consolidating = true
    try {
      const place = { db: this.db, index: () => this.memoryIndex() }
      for (const outcome of await keepEveryOwner(place)) {
        const { ownerId } = outcome.state
        if (!('report' in outcome)) {
          console.warn(`[Consolidate] ${ownerId}'s memories are not consolidated since ${outcome.state.since}: ${outcome.state.reason}`)
          continue
        }
        const { report } = outcome
        if (report.deduped || report.promoted) {
          console.log(`[Consolidate] ${ownerId}: ${report.live} live memories`
            + ` (deduped ${report.deduped}, promoted ${report.promoted},`
            + ` indexed ${report.indexed})`)
        }
        this.lastConsolidation = report
      }
    } catch (err) {
      console.warn(`[Consolidate] pass failed: ${(err as Error).message}`)
    } finally {
      this.consolidating = false
    }
  }

  async cancelIfRunning(wfId: string): Promise<boolean> {
    if (!this.client) return false
    return (await cancelIfRunning(this.client.workflow.getHandle(wfId))) !== 'not-running'
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

  async deployApp(config: Record<string, unknown>, userId?: string): Promise<ResourceDeal> {
    const { workflowId, deployment } = await startAppDeploy(this.appDeployDeps(), deployRequestOf(config), userId)
    return {
      id: workflowId,
      resourceId: deployment.id,
      event: 'app-deploy',
    }
  }

  appDeployDeps(): AppDeployDeps {
    return { db: this.db, client: () => this.client, masterKey: this.masterKey, clusterById: (id) => this.getClusterById(id), handOver: (clusterId) => this.clusterAccess().handOver(clusterId), logDir: this.logDir, toolCalling: { decide: async (app, asking) => this.toolCalling().decide(app, asking) } }
  }

  async destroyApp(deploymentId: string): Promise<WorkflowDeal> {
    const found = (await this.db.infrastructure.getDeployments()).find((d: DeploymentMetadata) => d.id === deploymentId)
    if (!found) throw new Error('DeploymentMetadata not found (destroyApp)')
    if (found.status === 'deploying' && found.temporalWorkflowId) await this.stopDeploy(found)
    const dep = (await this.db.infrastructure.getDeployments()).find((d: DeploymentMetadata) => d.id === deploymentId)
    if (!dep) throw new Error('DeploymentMetadata not found (destroyApp)')

    const cluster = await this.getClusterById(dep.clusterId)
    const wfId = destroyAppWorkflowId(dep, Date.now(), Math.random().toString(36).slice(2, 8))
    const logFileName = `${Date.now()}-${Math.random().toString(36).slice(2)}-D4.log`
    const absoluteLogPath = path.join(this.logDir, logFileName)

    const activityArgs = destroyAppArgs(dep, cluster, absoluteLogPath, await this.clusterAccess().handOver(dep.clusterId))

    await this.forProject(dep.gitappProjectId, () => this.client!.workflow.start(executeDestroyAppWorkflow, {
      workflowId: wfId,
      taskQueue: CLUSTER_QUEUE,
      args: [activityArgs],
      ...startedFor(dep.ownerId ?? PLATFORM_OWNER),
    }))

    await this.db.infrastructure.saveDeploymentInfo({
      id: dep.id,
      status: 'destroying',
      temporalWorkflowId: wfId,
      lastLogPath: absoluteLogPath,
    })

    return {
      id: wfId,
      event: 'app-destroy',
    }
  }

  private async stopDeploy(dep: DeploymentMetadata): Promise<void> {
    const wfId = dep.temporalWorkflowId!
    await this.client!.workflow.getHandle(wfId).cancel().catch((err: unknown) => {
      if (!(err instanceof WorkflowNotFoundError)) throw err
    })
    this.followRecord({ kind: 'deployment', record: dep })
    await this.following.get(wfId)
  }

  private async startFollowedAs(dep: DeploymentMetadata, wfId: string, followedFor: NonNullable<DeploymentMetadata['followedFor']>, start: () => Promise<unknown>): Promise<void> {
    await this.forProject(dep.gitappProjectId, start)
    await this.db.infrastructure.saveDeploymentInfo({ id: dep.id, temporalWorkflowId: wfId, followedFor })
  }

  async resizeDisk(deploymentId: string, storage: Record<string, string>): Promise<WorkflowDeal> {
    const deployments = await this.db.infrastructure.getDeployments()
    const [dep] = deployments.filter((d: DeploymentMetadata) => d.id === deploymentId)
    if (!dep) throw new Error('DeploymentMetadata not found (resizeDisk)')

    const cluster = await this.getClusterById(dep.clusterId)
    const handed = await this.clusterAccess().handOver(dep.clusterId)
    const wfId = `resize-disk-${dep.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const logFileName = `${Date.now()}-${Math.random().toString(36).slice(2)}-E5.log`
    const absoluteLogPath = path.join(this.logDir, logFileName)

    const activityArgs = {
      name: dep.name,
      namespace: dep.namespace,
      ...handed,
      ...appStackOf(dep, cluster),
      strategy: dep.strategy || 'helm',
      appType: appTypeOf(dep),
      storage,
      logFile: absoluteLogPath,
    }

    await this.db.infrastructure.saveDeploymentInfo({
      ...dep,
      status: 'deploying',
      healthReason: '',
      deployNotes: [],
      temporalWorkflowId: '',
      lastLogPath: absoluteLogPath,
    })

    await this.startFollowedAs(dep, wfId, { workflowId: wfId, action: 'app-resize', newStorage: storage }, () => this.client!.workflow.start(executeResizeDiskWorkflow, { workflowId: wfId, taskQueue: CLUSTER_QUEUE, args: [activityArgs], ...startedFor(dep.ownerId ?? PLATFORM_OWNER) }))

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
    dep = resolveAppSettingsDefaults(dep)

    const openaiApiBaseUrl = resolveOpenaiApiBaseUrl(dep, deployments);

    const cluster = await this.getClusterById(dep.clusterId)
    const handed = await this.clusterAccess().handOver(dep.clusterId)
    const wfId = `sync-config-${dep.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const logFileName = `${Date.now()}-${Math.random().toString(36).slice(2)}-G7.log`
    const absoluteLogPath = path.join(this.logDir, logFileName)

    const activityArgs = {
      name: dep.name,
      namespace: dep.namespace,
      ...handed,
      ...appStackOf(dep, cluster),
      ...servingArgsOf(dep),
      appType: appTypeOf(dep),
      webRepo: dep.webRepo,
      webTag: dep.webTag,
      dbRepo: dep.dbRepo,
      dbTag: dep.dbTag,
      storage: dep.storage || {},
      logFile: absoluteLogPath,
      ...appSettingsOf(dep),
      ...(openaiApiBaseUrl ? { openaiApiBaseUrl } : {}),
    }

    await this.db.infrastructure.saveDeploymentInfo({
      id: dep.id,
      status: 'deploying',
      healthReason: '',
      deployNotes: [],
      temporalWorkflowId: '',
      lastLogPath: absoluteLogPath,
    })

    await this.startFollowedAs(dep, wfId, { workflowId: wfId, action: 'app-sync-config' }, () => this.client!.workflow.start(executeSyncConfigWorkflow, { workflowId: wfId, taskQueue: CLUSTER_QUEUE, args: [activityArgs], ...startedFor(dep.ownerId ?? PLATFORM_OWNER) }))

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
    const absoluteLogPath = path.join(this.logDir, logFileName)

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

    await this.forProject(project.id, () => this.client!.workflow.start(executePipelineRunWorkflow, {
      workflowId: wfId,
      taskQueue: CLUSTER_QUEUE,
      args: [activityArgs],
      ...startedFor(project.ownerId ?? PLATFORM_OWNER),
    }))

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
    await this.forProject(args.projectId, () => this.client!.workflow.start(executeIngestWorkflow, {
      taskQueue: QUEUES.host,
      workflowId,
      args: [{ ownerId, url, ...definedFields(limits) }],
      ...startedFor(args.ownerId),
    }))
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
    return { id: workflowId, resourceId: deployment.id, event: 'app-deploy' }
  }
}
