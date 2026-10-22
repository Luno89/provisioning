import path from 'path';
import { isCommitSha, type BuildPlan } from '../../releases/lib/build-plan.js'
import { stopIfRunning } from '../../platform/lib/stop-workflow.js'
import { looksLikeMcp, namespaceOfDeployment } from '../../engine/lib/mcp-registry.js'
import { namespaceOf } from '../lib/app-namespace.js'
import { cachedProbes } from '../../engine/lib/mcp-probe-url.js'
import { healthFromProbe } from '../lib/service-health.js'
import { fileURLToPath } from 'url';
import fs from 'fs';
import type { Client } from '@temporalio/client'

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_DIR = path.resolve(__dirname, '../../../data/logs');
import { getTemporalClient, pollWorkflowRun } from '../../platform/lib/temporal-client.js'
import { DEFAULT_ENGINE_TASK_QUEUE, type GroveRunResult } from '../../engine-host/temporal/contracts.js'

export type GroveRunStatus =
  | { state: 'none' | 'unavailable' }
  | { state: 'running'; startedAt: string; turnId?: string | undefined; asking?: WaitingAsk[] | undefined }
  | { state: 'finished'; startedAt: string; closedAt?: string; result: GroveRunResult; turnId?: string | undefined }
  | { state: 'failed'; startedAt: string; closedAt?: string; reason: string; turnId?: string | undefined }
import { reconcileRun, reconcileMissingWorkflow, LIVE_RUN_STATUSES, type RunStatus } from '../../engine/lib/run-reconcile.js'
import { deploymentForProject } from '../../projects/lib/project-status.js'
import { destroyAppArgs, destroyAppWorkflowId } from '../lib/app-destroy.js'
import { resolveCloudCredentials } from '../lib/credential-resolver.js'
import { decryptValue, encryptValue, type SecretKey } from '../../platform/lib/crypto.js'
import { generateSshKeypair } from '../lib/ssh-keypair.js'
import { consolidateMemories, type ConsolidationReport } from '../../memory/lib/memory-consolidate.js'
import { corpusEndpointsWith, webToolsDepsFrom } from '../../engine/lib/web-tools-resolver.js'
import { sharedClusterProxy } from './ClusterProxyService.js'
import { indexMemories, similarTo } from '../../memory/lib/memory-index.js'
import { assessWorkload, reconciledStatus } from '../lib/workload-health.js'
import { InfrastructureService } from './InfrastructureService.js'
import { isModelKind } from '../../models/lib/model-registry.js'
import type { Database } from '../../platform/lib/db-interface.js'
import type { WaitingAsk } from '../../engine/lib/turn-log.js'
import type { ClusterMetadata, ClusterProgress, DeploymentMetadata, ProjectMetadata, PipelineRunMetadata } from '../../platform/lib/types.js'
import { ClusterService } from './ClusterService.js'
import { ClusterProvisionWorkflow } from '../../workflows/ClusterProvisionWorkflow.js'
import { executeDestroyClusterWorkflow } from '../../workflows/DestroyClusterWorkflow.js'
import { deployProjectBuild, startAppDeploy, resolveOpenaiApiBaseUrl, type AppDeployDeps } from './AppDeploy.js'
import { executeDestroyAppWorkflow } from '../../workflows/DestroyAppWorkflow.js'
import { executeResizeDiskWorkflow } from '../../workflows/ResizeDiskWorkflow.js'
import { executeSyncConfigWorkflow } from '../../workflows/SyncConfigWorkflow.js'
import { executePipelineRunWorkflow } from '../../workflows/PipelineRunWorkflow.js'
import { resolveVllmDefaults, resolveTabbyDefaults, resolveCrawl4aiDefaults, resolveSearxngDefaults,
  resolveMinioDefaults, resolveNextcloudDefaults, resolveQdrantDefaults, resolveQuickwitDefaults } from '../lib/app-env.js'
import { resolveAppSettingsDefaults } from '../lib/app-schemas.js'
import type { Server as SocketServer } from 'socket.io'
import { PLATFORM_OWNER, ownerIn, startedFor } from '../../platform/lib/workflow-owner.js'

const HOST_QUEUE = 'host-ops-queue'
const CLUSTER_QUEUE = 'cluster-ops-queue'
const WORKFLOW_POLL_INTERVAL = 5000
const RECONCILE_INTERVAL = 30000

const CONSOLIDATE_INTERVAL = 1_800_000
const MAX_POLL_FAILURES = 12

const DEEP_MERGE_FIELDS = ['storage', 'appSettings'] as const

export interface WorkflowDeal {
  readonly id: string
  readonly resourceId?: string
  readonly event: string
}

async function getDefaultClient(address?: string): Promise<Client> {
  return getTemporalClient({ ...(address !== undefined ? { address } : {}) })
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
  const existing = clusters.find((c: any) => c.id === clusterId);

  if (status === 'destroyed') {
    await db.infrastructure.saveClusterList(clusters.filter((c: any) => c.id !== clusterId));
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
  const existing = runs.find((r: any) => r.id === runId);
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
    const project = projects.find((p: any) => p.id === existing.projectId);
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
  const existing = deployments.find((d: any) => d.id === deploymentId);
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

export const connectToTemporal = async (address: string): Promise<Client> => {
  const c = await getDefaultClient(address)
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
  private readonly following = new Set<string>()
  clusterService?: ClusterService
  headscale?: { createPreAuthKey(userId: string, opts?: { reusable?: boolean; expirySeconds?: number }): Promise<{ key: string }> }

  lastConsolidation?: ConsolidationReport

  constructor(
    db: Database,
    io?: SocketServer,
    masterKey?: SecretKey,
    clusterService?: ClusterService,
    headscale?: { createPreAuthKey(userId: string, opts?: { reusable?: boolean; expirySeconds?: number }): Promise<{ key: string }> },
  ) {
    this.db = db
    this.io = io
    this.masterKey = masterKey || ''
    if (clusterService !== undefined) this.clusterService = clusterService
    if (headscale !== undefined) this.headscale = headscale
  }

  onBuilt?: (project: ProjectMetadata, run: PipelineRunMetadata) => Promise<boolean>

  ensureSecrets?: (project: ProjectMetadata) => Promise<{ waiting: string[] }>
  decideRelease?: (project: ProjectMetadata, since: string, commit: string) => Promise<{ release: true } | { release: false; reason: string }>
  planBuild?: (project: ProjectMetadata, commitSha: string) => Promise<BuildPlan>

  isReady(): boolean {
    return !!this.client
  }

  private async getClusterById(id: string): Promise<ClusterMetadata | undefined> {
    if (id === 'provisioning-lunorica' && this.clusterService) {
      return this.clusterService.getSystemClusterEntry();
    }
    const clusters = await this.db.infrastructure.getClusters();
    return clusters.find((c: ClusterMetadata) => c.id === id);
  }

  async start(address?: string): Promise<this> {
    const c = await getDefaultClient(address)
    this.client = c
    return this
  }

  async flush(): Promise<void> {
  }

  async stop(): Promise<void> {
    try {
      await this.client.connection.close()
    } catch { /* ignored */ }
  }

  private async appliedOutcome(
    wfId: string,
    meta: any,
  ): Promise<{ status: 'running' | 'unhealthy'; meta: any }> {
    let verdict: { workload?: string; workloadReason?: string } = {}
    try {
      verdict = (await this.client.workflow.getHandle(wfId).result()) as typeof verdict
    } catch {}
    const unhealthy = verdict.workload === 'unhealthy'
    return {
      status: unhealthy ? 'unhealthy' : 'running',
      meta: { ...meta, healthReason: unhealthy ? (verdict.workloadReason ?? '') : '' },
    }
  }

  trackWorkflow(
    wfId: string,
    action: 'cluster-provision' | 'cluster-destroy' | 'app-deploy' | 'app-destroy' | 'app-resize' | 'app-sync-config' | 'pipeline-run',
    resourceId: string,
    resourceName: string,
    provider: ClusterMetadata['provider'] | '',
    meta?: any
  ) {
    if (this.following.has(wfId)) return
    this.following.add(wfId)
    let consecutiveFailures = 0
    const timer = setInterval(async () => {
      try {
        const status = await pollWorkflowRun(wfId)
        consecutiveFailures = 0

        if (status && status.status?.name !== 'RUNNING') {
          clearInterval(timer)
          this.following.delete(wfId)
          const name = status.status?.name
          let kubeconfig: string | undefined
          if (name === 'COMPLETED' && action === 'cluster-provision') {
            try {
              const handle = this.client.workflow.getHandle(wfId)
              const wfResult = await handle.result()
              kubeconfig = (wfResult as any).kubeconfig
              const meshIp = (wfResult as any).meshIp
              if (meshIp) {
                const current = (await this.db.infrastructure.getClusters()).find((c: ClusterMetadata) => c.id === resourceId)
                await this.db.infrastructure.saveClusterInfo({ ...(current ?? {}), id: resourceId, name: resourceName, provider, meshIp } as any)
              }
              const vmHost = (wfResult as any).createdHost
              if (vmHost) {
                const current = (await this.db.infrastructure.getClusters()).find((c: ClusterMetadata) => c.id === resourceId)
                await this.db.infrastructure.saveClusterInfo({
                  ...(current ?? {}),
                  id: resourceId,
                  name: resourceName,
                  provider,
                  remoteHost: vmHost,
                  remoteUsername: (wfResult as any).createdUsername,
                  remoteSshPrivateKeyEnc: encryptValue((wfResult as any).createdPrivateKey, this.masterKey),
                  hetznerServerId: (wfResult as any).hetznerServerId,
                  doServerId: (wfResult as any).doServerId,
                } as any)
              }
              const capacity = (wfResult as any).capacity
              if (capacity) {
                const current = (await this.db.infrastructure.getClusters()).find((c: ClusterMetadata) => c.id === resourceId)
                await this.db.infrastructure.saveClusterInfo({ ...(current ?? {}), id: resourceId, name: resourceName, provider, capacity } as any)
              }
            } catch {}
          }
          const applied = name === 'COMPLETED' && (action === 'app-deploy' || action === 'app-sync-config' || action === 'app-resize')
            ? await this.appliedOutcome(wfId, meta)
            : { status: 'running' as const, meta }
          const appliedStatus = applied.status
          const appliedMeta = applied.meta

          let pipelineImageTag: string | undefined
          if (name === 'COMPLETED' && action === 'pipeline-run') {
            try {
              const handle = this.client.workflow.getHandle(wfId)
              const wfResult = await handle.result()
              pipelineImageTag = (wfResult as any).imageTag
            } catch {}
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
              await updateDeploymentStatus(this.db, resourceId, meta, 'failed', meta?.storage)
            } else if (name === 'TERMINATED' || name === 'CANCELLED') {
              await updateDeploymentStatus(this.db, resourceId, meta, 'failed', meta?.storage)
            } else if (name === 'COMPLETED') {
              await updateDeploymentStatus(this.db, resourceId, appliedMeta, appliedStatus, meta?.storage)
              if (appliedStatus === 'running') {
                await maybeSetDefaultModel(this.db, resourceId, appliedMeta?.ownerId, appliedMeta?.appType)
              }
            }
            if (this.io) this.io.emit('deployment-updated')
          } else if (action === 'app-destroy') {
            if (name === 'FAILED') {
              await updateDeploymentStatus(this.db, resourceId, meta, 'failed', meta?.storage)
            } else if (name === 'TERMINATED' || name === 'CANCELLED' || name === 'COMPLETED') {
              await this.db.infrastructure.deleteDeployment(resourceId)
            }
            if (this.io) this.io.emit('deployment-updated')
          } else if (action === 'app-resize') {
            const newStorage = { ...meta?.storage, ...meta?.newStorage }
            if (name === 'FAILED') {
              await updateDeploymentStatus(this.db, resourceId, meta, 'failed', meta?.storage)
            } else if (name === 'TERMINATED' || name === 'CANCELLED') {
              await updateDeploymentStatus(this.db, resourceId, meta, 'failed', meta?.storage)
            } else if (name === 'COMPLETED') {
              await updateDeploymentStatus(this.db, resourceId, appliedMeta, appliedStatus, newStorage)
            }
            if (this.io) this.io.emit('deployment-updated')
          } else if (action === 'app-sync-config') {
            if (name === 'FAILED' || name === 'TERMINATED' || name === 'CANCELLED') {
              await updateDeploymentStatus(this.db, resourceId, meta, 'failed', meta?.storage)
            } else if (name === 'COMPLETED') {
              await updateDeploymentStatus(this.db, resourceId, appliedMeta, appliedStatus, meta?.storage)
            }
            if (this.io) this.io.emit('deployment-updated')
          } else if (action === 'pipeline-run') {
            if (name === 'FAILED' || name === 'TERMINATED' || name === 'CANCELLED') {
              await updatePipelineRunStatus(this.db, resourceId, 'failed', { errorMessage: `Workflow ${name}` })
            } else if (name === 'COMPLETED') {
              await updatePipelineRunStatus(this.db, resourceId, 'succeeded', pipelineImageTag !== undefined ? { imageTag: pipelineImageTag } : {})
              try {
                const [projects, runs] = await Promise.all([this.db.projects.getProjects(), this.db.releases.getPipelineRuns()])
                const run = runs.find((r: any) => r.id === resourceId)
                const project = run && projects.find((p: any) => p.id === run.projectId)
                const released = project && run && this.onBuilt ? await this.onBuilt(project, run) : false
                if (!released && project?.autoDeployOnBuild && run) {
                  const since = deploymentForProject(project, await this.db.infrastructure.getDeployments())?.gitappImageTag?.split(':').pop()
                  const decision = since && this.decideRelease ? await this.decideRelease(project, since, run.commitSha) : { release: true as const }
                  if (decision.release) await this.promoteProjectBuild(project, run)
                  else await this.db.releases.savePipelineRunInfo({ id: run.id, releaseSkipped: decision.reason })
                }
              } catch (err: any) {
                console.error(`[TemporalBridge] Auto-deploy-on-build failed for pipeline run ${resourceId}: ${err.message}`)
              }
            }
            if (this.io) this.io.emit('pipeline-run-updated')
          }
        }
      } catch (err: any) {
        consecutiveFailures++
        if (consecutiveFailures >= MAX_POLL_FAILURES) {
          clearInterval(timer)
          this.following.delete(wfId)
          console.error(`[TemporalBridge] Workflow ${wfId} polling failed ${consecutiveFailures} times — giving up`)
        } else {
          console.warn(`[TemporalBridge] Failed polling workflow ${wfId} (${consecutiveFailures}/${MAX_POLL_FAILURES}): ${err.message}`)
        }
      }
    }, WORKFLOW_POLL_INTERVAL)
  }

  async adoptPlan(ownerId: string, proposalId: string): Promise<string | undefined> {
    if (!this.client) return undefined
    const workflowId = `adopt-plan-${proposalId}`
    await this.client.workflow.start('AdoptPlanWorkflow', {
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
        this.client = await getDefaultClient()
      } catch (err: any) {
        console.warn(`[TemporalBridge] Skipping recovery, Temporal client not ready: ${err.message}`)
        return
      }
    }

    console.log('[TemporalBridge] Running active workflow recovery check...')

    const clusters = await this.db.infrastructure.getClusters()
    for (const cluster of clusters) {
      if (cluster.status === 'provisioning' || cluster.status === 'destroying') {
        const wfId = cluster.temporalWorkflowId
        if (wfId) {
          const action = cluster.status === 'provisioning' ? 'cluster-provision' : 'cluster-destroy'
          console.log(`[TemporalBridge] Resuming polling for cluster workflow: ${wfId}`)
          this.trackWorkflow(wfId, action, cluster.id, cluster.name, cluster.provider)
        }
      }
    }

    const deployments = await this.db.infrastructure.getDeployments()
    for (const dep of deployments) {
      if (dep.status === 'deploying' || dep.status === 'destroying') {
        const wfId = dep.temporalWorkflowId
        if (wfId) {
          const action = dep.status === 'deploying' ? 'app-deploy' : 'app-destroy'
          console.log(`[TemporalBridge] Resuming polling for deployment workflow: ${wfId}`)
          this.trackWorkflow(wfId, action, dep.id, dep.name, '', dep)
        }
      }
    }

    this.startReconciliationLoop()
  }

  private startReconciliationLoop(): void {
    const reconcile = async () => {
      if (!this.client) return
      try {
        const clusters = await this.db.infrastructure.getClusters()
        for (const cluster of clusters) {
          if (cluster.status !== 'provisioning' && cluster.status !== 'destroying') continue
          const wfId = cluster.temporalWorkflowId
          if (!wfId) continue

          const wfStatus = await pollWorkflowRun(wfId)
          const statusName = wfStatus?.status?.name
          if (!statusName) continue

          if (statusName !== 'RUNNING') {
            console.log(`[Reconcile] Cluster ${cluster.name} workflow is ${statusName} but DB says ${cluster.status} — fixing`)
            const action = cluster.status === 'provisioning' ? 'cluster-provision' : 'cluster-destroy'
            if (action === 'cluster-provision') {
              if (statusName === 'FAILED') {
                await updateUserStatus(this.db, cluster.id, cluster.name, cluster.provider, 'failed')
              } else if (statusName === 'TERMINATED' || statusName === 'CANCELLED') {
                await updateUserStatus(this.db, cluster.id, cluster.name, cluster.provider, 'destroyed')
              } else {
                let kubeconfig: string | undefined
                try {
                  const handle = this.client.workflow.getHandle(wfId)
                  const wfResult = await handle.result()
                  kubeconfig = (wfResult as any).kubeconfig
                } catch {}
                await updateUserStatus(this.db, cluster.id, cluster.name, cluster.provider, 'healthy', kubeconfig)
              }
            } else {
              if (statusName === 'FAILED') {
                await updateUserStatus(this.db, cluster.id, cluster.name, cluster.provider, 'failed')
              } else {
                await updateUserStatus(this.db, cluster.id, cluster.name, cluster.provider, 'destroyed')
              }
            }
            if (this.io) this.io.emit('cluster-updated')
          }

          if (statusName === 'RUNNING' && cluster.lastLogPath) {
            const progress = inferProgressFromLog(cluster.lastLogPath)
            if (progress) {
              await this.db.infrastructure.updateClusterProgress(cluster.id, progress)
            }
          }
        }

        const deployments = await this.db.infrastructure.getDeployments()
        for (const dep of deployments) {
          if ((dep.status === 'deploying' || dep.status === 'destroying') && dep.temporalWorkflowId) {
            this.trackWorkflow(dep.temporalWorkflowId, dep.status === 'deploying' ? 'app-deploy' : 'app-destroy', dep.id, dep.name, '', dep)
          }
        }

        const kubeconfigForCluster = new Map<string, string | undefined>()
        const resolveKubeconfig = async (clusterId: string): Promise<string | undefined> => {
          if (kubeconfigForCluster.has(clusterId)) return kubeconfigForCluster.get(clusterId)
          let path: string | undefined
          try {
            const cluster = await this.clusterService?.getByIdUnscoped(clusterId)
            if (cluster) path = await this.clusterService!.getKubeconfigPath(cluster)
          } catch { /* ignored */ }
          kubeconfigForCluster.set(clusterId, path)
          return path
        }

        for (const dep of deployments) {
          if (dep.status !== 'running' && dep.status !== 'unhealthy') continue
          try {
            const kubeconfig = await resolveKubeconfig(dep.clusterId)
            if (!kubeconfig) continue
            const namespace = namespaceOf(dep)
            const raw = await new InfrastructureService().runKubectl(['get', 'pods', '-n', namespace, '-o', 'json'], kubeconfig)
            const { health, reason } = assessWorkload(JSON.parse(raw))

            let serviceReason = ''
            if (health === 'healthy' && looksLikeMcp(dep) && dep.ownerId) {
              try {
                const verdict = healthFromProbe(await this.mcpProbes(namespaceOfDeployment(dep)))
                if (verdict) serviceReason = verdict.reason
              } catch { /* ignored */ }
            }

            const effective = serviceReason ? 'unhealthy' as const : health
            const next = reconciledStatus(dep.status, effective)
            if (next) {
              console.warn(`[Reconcile] ${dep.name} is ${dep.status} but the workload is ${effective}${(serviceReason || reason) ? ` (${serviceReason || reason})` : ''} — marking ${next}`)
              await updateDeploymentStatus(this.db, dep.id, { ...dep, healthReason: serviceReason || reason }, next, dep.storage)
              if (this.io) this.io.emit('deployment-updated')
            }
          } catch { /* ignored */ }
        }

        for (const dep of deployments) {
          if (dep.status !== 'deploying' && dep.status !== 'destroying') continue
          const depWfId = dep.temporalWorkflowId
          if (!depWfId) continue

          const depWfStatus = await pollWorkflowRun(depWfId)
          const depStatusName = depWfStatus?.status?.name
          if (!depStatusName) continue

          if (depStatusName !== 'RUNNING') {
            console.log(`[Reconcile] Deployment ${dep.name} workflow is ${depStatusName} but DB says ${dep.status} — fixing`)
            const depAction = dep.status === 'deploying' ? 'app-deploy' : 'app-destroy'
            if (depAction === 'app-deploy') {
              if (depStatusName === 'FAILED' || depStatusName === 'TERMINATED' || depStatusName === 'CANCELLED') {
                await updateDeploymentStatus(this.db, dep.id, dep, 'failed', dep.storage)
              } else {
                const applied = await this.appliedOutcome(depWfId, dep)
                await updateDeploymentStatus(this.db, dep.id, applied.meta, applied.status, dep.storage)
              }
            } else {
              await this.db.infrastructure.deleteDeployment(dep.id)
            }
            if (this.io) this.io.emit('deployment-updated')
          }
        }
      } catch (err: any) {
        console.warn(`[Reconcile] Error: ${err.message}`)
      }

    }

    const reconcileRuns = async () => {
      if (!this.client) return
      try {
        const runs = await this.db.releases.getPipelineRuns()
        for (const run of runs) {
          const current = run.status as RunStatus
          if (!(LIVE_RUN_STATUSES as readonly string[]).includes(current)) continue

          let next: RunStatus | undefined
          try {
            const described = await pollWorkflowRun(run.temporalWorkflowId!)
            next = reconcileRun(current, described?.status?.name)
          } catch (err: any) {
            const missing = /not\s*found/i.test(String(err?.message ?? err))
            if (!missing) continue
            next = reconcileMissingWorkflow(current, run.startedAt)
          }

          if (!next) continue
          await this.db.releases.savePipelineRunInfo({ ...run, status: next })
          console.warn(`[Reconcile] pipeline run ${String(run.commitSha).slice(0, 8)}: ${current} -> ${next} (its workflow had already ended)`)
          if (this.io) this.io.emit('pipeline-run-updated')
        }
      } catch (err: any) {
        console.warn(`[Reconcile] Could not reconcile pipeline runs: ${err.message}`)
      }
    }

    let consolidating = false
    const consolidate = async () => {
      if (consolidating) return
      consolidating = true
      try {
        const owners = [...new Set((await this.db.memory.getMemories().catch(() => [])).map((memory) => memory.ownerId))]
        for (const ownerId of owners) {
          const ends = await corpusEndpointsWith(webToolsDepsFrom(this.db.infrastructure, this.clusterService ?? new ClusterService(this.db, new InfrastructureService()), sharedClusterProxy()), ownerId).catch(() => undefined)
          const report = await consolidateMemories({
            db: this.db,
            ownerId,
            ...(ends ? {
              index: (items) => indexMemories(ends, items),
              similar: async (ids: string[]) => {
                const out = new Map<string, { id: string; score: number }[]>()
                for (const id of ids) {
                  out.set(id, await similarTo(ends, id, { ownerId }).catch(() => []))
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
      } catch (err: any) {
        console.warn(`[Consolidate] pass failed: ${err.message}`)
      } finally {
        consolidating = false
      }
    }

    reconcile()
    setInterval(reconcile, RECONCILE_INTERVAL)
    consolidate()
    setInterval(consolidate, CONSOLIDATE_INTERVAL)
    reconcileRuns()
    setInterval(reconcileRuns, RECONCILE_INTERVAL)
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
    } catch (err: any) {
      console.warn(`[TemporalBridge] Failed to terminate workflow ${wfId}: ${err.message}`);
      return false;
    }
  }

  private async resolveHetznerToken(userId?: string): Promise<string | undefined> {
    let userCreds: any
    if (userId) {
      const user = await this.db.accounts.getUserById(userId)
      const enc = (user?.credentials as any)?.hetzner?.token
      if (enc) {
        try {
          userCreds = { hetzner: { token: decryptValue(enc, this.masterKey) } }
        } catch { /* ignored */ }
      }
    }
    return resolveCloudCredentials('hetzner', userCreds).env.HCLOUD_TOKEN
  }

  private async resolveDoToken(userId?: string): Promise<string | undefined> {
    let userCreds: any
    if (userId) {
      const user = await this.db.accounts.getUserById(userId)
      const enc = (user?.credentials as any)?.do?.token
      if (enc) {
        try {
          userCreds = { do: { token: decryptValue(enc, this.masterKey) } }
        } catch { /* ignored */ }
      }
    }
    return resolveCloudCredentials('do', userCreds).env.DIGITALOCEAN_TOKEN
  }

  async provision(
    clusterName: string,
    provider: ClusterMetadata['provider'],
    userId: string,
    remote?: { host: string; username: string; privateKey: string; port?: number; k3sApiPort?: number },
    hetzner?: { serverType?: string; location?: string; image?: string },
  ): Promise<WorkflowDeal> {
    const wfId = `cluster-provision-${clusterName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const logFileName = `${Date.now()}-${Math.random().toString(36).slice(2)}-A1.log`
    const absoluteLogPath = path.join(LOG_DIR, logFileName)
    const hcloudToken = provider === 'hetzner' ? await this.resolveHetznerToken(userId) : undefined
    if (provider === 'hetzner' && !hcloudToken) {
      throw new Error('No Hetzner Cloud API token configured — add one under Cloud Accounts first')
    }
    const doToken = provider === 'do' ? await this.resolveDoToken(userId) : undefined
    if (provider === 'do' && !doToken) {
      throw new Error('No DigitalOcean API token configured — add one under Cloud Accounts first')
    }
    const createsVm = provider === 'hetzner' || provider === 'do'

    const vmKeypair = createsVm
      ? await generateSshKeypair(`provisioning-${clusterName}`)
      : undefined

    const meshLoginServer = process.env.MESH_LOGIN_SERVER
    let meshPreAuthKey: string | undefined
    if (createsVm && meshLoginServer && this.headscale) {
      try {
        meshPreAuthKey = (await this.headscale.createPreAuthKey(userId, { reusable: true, expirySeconds: 2 * 60 * 60 })).key
      } catch (err: any) {
        console.error(`[TemporalBridge] Could not mint a mesh pre-auth key for "${clusterName}" — provisioning without mesh join: ${err.message}`)
      }
    }

    const activityArgs = {
      name: clusterName,
      provider,
      logFile: absoluteLogPath,
      ...(remote ? {
        remoteHost: remote.host,
        remoteUsername: remote.username,
        remoteSshPrivateKey: remote.privateKey,
        ...(remote.port !== undefined ? { remoteSshPort: remote.port } : {}),
        ...(remote.k3sApiPort !== undefined ? { remoteK3sApiPort: remote.k3sApiPort } : {}),
      } : {}),
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
      temporalWorkflowId: wfId,
      lastLogPath: absoluteLogPath,
      createdAt: new Date().toISOString(),
      ownerId: userId,
      ...(remote ? {
        remoteHost: remote.host,
        remoteUsername: remote.username,
        remoteSshPrivateKeyEnc: encryptValue(remote.privateKey, this.masterKey),
        ...(remote.port !== undefined ? { remoteSshPort: remote.port } : {}),
        ...(remote.k3sApiPort !== undefined ? { remoteK3sApiPort: remote.k3sApiPort } : {}),
      } : {}),
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

    this.trackWorkflow(wfId, 'cluster-provision', savedCluster.id, clusterName, provider)

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
      ...(cluster.provider === 'remote' && cluster.remoteHost && cluster.remoteUsername && cluster.remoteSshPrivateKeyEnc ? {
        remoteHost: cluster.remoteHost,
        remoteUsername: cluster.remoteUsername,
        remoteSshPrivateKey: decryptValue(cluster.remoteSshPrivateKeyEnc, this.masterKey),
        ...(cluster.remoteSshPort !== undefined ? { remoteSshPort: cluster.remoteSshPort } : {}),
      } : {}),
      ...(hcloudToken ? { hcloudToken } : {}),
      ...(doToken ? { doToken } : {}),
      ...(cluster.doServerId ? { doServerId: cluster.doServerId } : {}),
      ...(cluster.hetznerServerId ? { hetznerServerId: cluster.hetznerServerId } : {}),
    }
    const wfId = `cluster-destroy-${cluster.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    this.db.infrastructure.saveClusterInfo({
      ...cluster,
      status: 'destroying',
      temporalWorkflowId: wfId,
      lastLogPath: absoluteLogPath,
    })

    await this.client.workflow.start(executeDestroyClusterWorkflow, {
      workflowId: wfId,
      taskQueue: HOST_QUEUE,
      args: [activityArgs],
      ...startedFor(cluster.ownerId ?? PLATFORM_OWNER),
    })

    this.trackWorkflow(wfId, 'cluster-destroy', cluster.id, cluster.name, cluster.provider)

    return {
      id: wfId,
      event: 'cluster-destroy',
    }
  }


  async deployApp(config: any, userId?: string): Promise<WorkflowDeal> {
    const { workflowId, deployment } = await startAppDeploy(this.appDeployDeps(), config, userId)
    this.trackWorkflow(workflowId, 'app-deploy', deployment.id, deployment.name, '', deployment)
    return {
      id: workflowId,
      resourceId: deployment.id,
      event: 'app-deploy',
    }
  }

  appDeployDeps(): AppDeployDeps {
    return { db: this.db, client: () => this.client, masterKey: this.masterKey, clusterById: (id) => this.getClusterById(id), logDir: LOG_DIR }
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

     this.db.infrastructure.saveDeploymentInfo({
      ...dep,
      status: 'destroying',
      temporalWorkflowId: wfId,
      lastLogPath: absoluteLogPath,
    })

    await this.client.workflow.start(executeDestroyAppWorkflow, {
      workflowId: wfId,
      taskQueue: CLUSTER_QUEUE,
      args: [activityArgs],
      ...startedFor(dep.ownerId ?? PLATFORM_OWNER),
    })

    this.trackWorkflow(wfId, 'app-destroy', dep.id, dep.name, '', dep)

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
      clusterId: dep.clusterId,
      clusterName: cluster?.name || 'unknown',
      provider: cluster?.provider || 'k3d',
      strategy: dep.strategy || 'helm',
      appType: dep.appType || 'odoo',
      storage,
      logFile: absoluteLogPath,
      deploymentId: dep.deploymentId || 'default',
    }

    this.db.infrastructure.saveDeploymentInfo({
      ...dep,
      storage: { ...dep.storage, ...storage },
      status: 'deploying',
      healthReason: '',
      temporalWorkflowId: wfId,
      lastLogPath: absoluteLogPath,
    })

    await this.client.workflow.start(executeResizeDiskWorkflow, {
      workflowId: wfId,
      taskQueue: CLUSTER_QUEUE,
      args: [activityArgs],
      ...startedFor(dep.ownerId ?? PLATFORM_OWNER),
    })

    this.trackWorkflow(wfId, 'app-resize', dep.id, dep.name, '', { ...dep, newStorage: storage })

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

    this.db.infrastructure.saveDeploymentInfo({
      ...dep,
      status: 'deploying',
      healthReason: '',
      temporalWorkflowId: wfId,
      lastLogPath: absoluteLogPath,
    })

    await this.client.workflow.start(executeSyncConfigWorkflow, {
      workflowId: wfId,
      taskQueue: CLUSTER_QUEUE,
      args: [activityArgs],
      ...startedFor(dep.ownerId ?? PLATFORM_OWNER),
    })

    this.trackWorkflow(wfId, 'app-sync-config', dep.id, dep.name, '', dep)

    return {
      id: wfId,
      event: 'config-sync',
    }
  }

  async updateConfigAndSync(deploymentId: string, patch: Partial<DeploymentMetadata>): Promise<WorkflowDeal> {
    const deployments = await this.db.infrastructure.getDeployments()
    const dep = deployments.find((d: DeploymentMetadata) => d.id === deploymentId)
    if (!dep) throw new Error('DeploymentMetadata not found (updateConfigAndSync)')

    const merged: Record<string, any> = { ...dep, ...patch }
    for (const field of DEEP_MERGE_FIELDS) {
      const incoming = (patch as Record<string, any>)[field]
      if (incoming) {
        merged[field] = { ...((dep as Record<string, any>)[field] ?? {}), ...incoming }
      }
    }
    await this.db.infrastructure.saveDeploymentInfo(merged)

    return this.syncConfig(deploymentId)
  }

  async listWorkflows(query?: string, pageSize?: number): Promise<any[]> {
    if (!this.isReady()) return [];
    try {
      const iter = this.client.workflow.list({ ...(query ? { query } : {}), pageSize: pageSize || 50 });
      const workflows: any[] = [];
      for await (const wf of iter) {
        workflows.push({
          workflowId: wf.workflowId,
          runId: wf.runId,
          type: wf.type,
          taskQueue: wf.taskQueue,
          status: wf.status?.name,
          startTime: wf.startTime?.toISOString?.() || wf.startTime,
          closeTime: wf.closeTime?.toISOString?.() || wf.closeTime,
          historyLength: wf.historyLength,
          owner: ownerIn(wf.typedSearchAttributes),
        });
      }
      return workflows;
    } catch { return []; }
  }

  async countWorkflows(query?: string): Promise<number> {
    if (!this.isReady()) return 0;
    try {
      const result = await this.client.workflow.count(query);
      return result.count;
    } catch { return 0; }
  }

  async describeWorkflow(workflowId: string): Promise<any | null> {
    if (!this.isReady()) return null;
    try {
      const handle = this.client.workflow.getHandle(workflowId);
      const desc = await handle.describe();
      return {
        workflowId: desc.workflowId,
        runId: desc.runId,
        type: desc.type,
        taskQueue: desc.taskQueue,
        status: desc.status?.name,
        startTime: desc.startTime?.toISOString?.() || desc.startTime,
        closeTime: desc.closeTime?.toISOString?.() || desc.closeTime,
        historyLength: desc.historyLength,
        owner: ownerIn(desc.typedSearchAttributes),
      };
    } catch { return null; }
  }

  async getWorkflowHistory(workflowId: string): Promise<any[] | null> {
    if (!this.isReady()) return null;
    try {
      const handle = this.client.workflow.getHandle(workflowId);
      const history = await handle.fetchHistory();
      return (history?.events || []).map((e: any) => ({
        id: e.eventId,
        type: e.eventType,
        time: e.eventTime?.toISOString?.() || e.eventTime,
        attributes: e.attributes ? JSON.stringify(e.attributes).slice(0, 500) : null,
      }));
    } catch { return null; }
  }

  async onClusterStatus(_query: string): Promise<ClusterMetadata[]> {
    return this.db.infrastructure.getClusters()
  }

  async onClusterStatusClearup(clusterId: string): Promise<void> {
    const deployments = await this.db.infrastructure.getDeployments()
    const arr = deployments.filter((d: any) => d.clusterId !== clusterId)
    await this.db.infrastructure.saveDeploymentList(arr)
  }

  async runPipeline(project: ProjectMetadata, commitSha: string, ref: string): Promise<WorkflowDeal> {
    if (!project.giteaOwner || !project.giteaRepo) {
      throw new Error(`Project ${project.id} has no repository to run a pipeline for.`)
    }
    if (!isCommitSha(commitSha)) throw new Error(`"${commitSha}" is not a commit to build`)
    const plan = this.planBuild ? await this.planBuild(project, commitSha) : undefined
    if (plan && !plan.build) {
      console.log(`[pipeline] ${project.name}: ${plan.reason}; no build recorded`)
      return { id: '', event: 'nothing-to-build' }
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
      temporalWorkflowId: wfId,
      startedAt: new Date().toISOString(),
    })
    await this.db.projects.saveProjectInfo({ ...project, lastBuildStatus: 'queued' })

    await this.client.workflow.start(executePipelineRunWorkflow, {
      workflowId: wfId,
      taskQueue: CLUSTER_QUEUE,
      args: [activityArgs],
      ...startedFor(project.ownerId ?? PLATFORM_OWNER),
    })

    this.trackWorkflow(wfId, 'pipeline-run', runId, project.giteaRepo, '')
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
    await this.client.workflow.start('executeIngestWorkflow', {
      taskQueue: 'host-ops-queue',
      workflowId,
      args: [args],
      ...startedFor(args.ownerId),
    })
    return { workflowId }
  }

  async ingestStatus(workflowId: string): Promise<{ state: string; receipt?: unknown; error?: string }> {
    try {
      const status = await pollWorkflowRun(workflowId)
      const name = status?.status?.name
      if (name === 'RUNNING') return { state: 'running' }
      if (name === 'COMPLETED') {
        const receipt = await this.client.workflow.getHandle(workflowId).result()
        return { state: 'completed', receipt }
      }
      return { state: (name ?? 'unknown').toLowerCase() }
    } catch (err: any) {
      return { state: 'unknown', error: err?.message ?? String(err) }
    }
  }

  async promoteProjectBuild(project: ProjectMetadata, run: PipelineRunMetadata, userId?: string): Promise<WorkflowDeal> {
    const secrets = await this.ensureSecrets?.(project)
    if (secrets?.waiting.length) throw new Error(`waiting for the person to enter ${secrets.waiting.join(', ')}`)
    const { workflowId, deployment } = await deployProjectBuild(this.appDeployDeps(), project, run, userId)
    this.trackWorkflow(workflowId, 'app-deploy', deployment.id, deployment.name, '', deployment)
    return { id: workflowId, resourceId: deployment.id, event: 'app-deploy' }
  }
}
