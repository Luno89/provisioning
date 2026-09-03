import path from 'path';
import { McpRegistryService } from '../services/McpRegistryService.js'
import { looksLikeMcp } from '../lib/mcp-registry.js'
import { resolveMcpProbeUrl } from '../lib/mcp-probe-url.js'
import { healthFromProbe } from '../lib/service-health.js'
import { fileURLToPath } from 'url';
import fs from 'fs';
import type { Client } from '@temporalio/client'

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_DIR = path.resolve(__dirname, '../../data/logs');
import { getTemporalClient, pollWorkflowRun } from '../lib/temporal-client.js'
import {
  LIVE_LEAF_STATUSES, reconcileLeaf, reconcileMissingLeafWorkflow, type LeafReconcileAction,
} from '../lib/leaf-reconcile.js'
import { reconcileRun, reconcileMissingWorkflow, LIVE_RUN_STATUSES, type RunStatus } from '../lib/run-reconcile.js'
import { deploymentIdFor } from '../lib/deployment-id.js'
import { resolveCloudCredentials } from '../lib/credential-resolver.js'
import { decryptValue, encryptValue } from '../lib/crypto.js'
import { generateSshKeypair } from '../lib/ssh-keypair.js'
import { readyToStart } from '../lib/leaves.js'
import { consolidateMemories, type ConsolidationReport } from '../lib/memory-consolidate.js'
import { corpusEndpoints } from '../lib/web-tools-resolver.js'
import { indexMemories, similarTo } from '../lib/memory-index.js'
import { assessWorkload, reconciledStatus } from '../lib/workload-health.js'
import { InfrastructureService } from './InfrastructureService.js'
import { sanitizeNamespace, isModelKind } from '../lib/model-registry.js'
import type { Database } from '../lib/db-interface.js'
import type { ClusterMetadata, ClusterProgress, DeploymentMetadata, ProjectMetadata, PipelineRunMetadata } from '../lib/types.js'
import { CapacityError, checkCapacity, requestedGpuCount } from '../lib/cluster-capacity.js'
import type { ClusterService } from './ClusterService.js'
import { ClusterProvisionWorkflow } from '../workflows/ClusterProvisionWorkflow.js'
import { LeafWorkflow } from '../workflows/LeafWorkflow.js'
import { ProjectPlanWorkflow } from '../workflows/ProjectPlanWorkflow.js'
import { executeDestroyClusterWorkflow } from '../workflows/DestroyClusterWorkflow.js'
import { executeDeployAppWorkflow } from '../workflows/AppDeployWorkflow.js'
import { executeDestroyAppWorkflow } from '../workflows/DestroyAppWorkflow.js'
import { executeResizeDiskWorkflow } from '../workflows/ResizeDiskWorkflow.js'
import { executeSyncConfigWorkflow } from '../workflows/SyncConfigWorkflow.js'
import { executePipelineRunWorkflow } from '../workflows/PipelineRunWorkflow.js'
import { resolveVllmDefaults, resolveTabbyDefaults, resolveCrawl4aiDefaults, resolveSearxngDefaults,
  resolveMinioDefaults, resolveQdrantDefaults, resolveQuickwitDefaults } from '../lib/app-env.js'
import { resolveAppSettingsDefaults } from '../lib/app-schemas.js'
import { resolveTabbyCacheHostPath, resolveVllmCacheHostPath } from '../lib/tabby-cache-path.js'
import type { Server as SocketServer } from 'socket.io'

const HOST_QUEUE = 'host-ops-queue'
const CLUSTER_QUEUE = 'cluster-ops-queue'
const WORKFLOW_POLL_INTERVAL = 5000
const RECONCILE_INTERVAL = 30000
const DEPENDENCY_BACKSTOP_INTERVAL = 300000

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
  const clusters = await db.getClusters();
  const existing = clusters.find((c: any) => c.id === clusterId);

  if (status === 'destroyed') {
    await db.saveClusterList(clusters.filter((c: any) => c.id !== clusterId));
    return;
  }
  await db.saveClusterInfo({
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
  const runs = await db.getPipelineRuns();
  const existing = runs.find((r: any) => r.id === runId);
  if (!existing) return;
  const imageTag = extra.imageTag ?? existing.imageTag;
  const errorMessage = extra.errorMessage ?? existing.errorMessage;
  await db.savePipelineRunInfo({
    ...existing,
    status,
    ...(imageTag !== undefined ? { imageTag } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    finishedAt: new Date().toISOString(),
  });
  if (status === 'succeeded' || status === 'failed') {
    const projects = await db.getProjects();
    const project = projects.find((p: any) => p.id === existing.projectId);
    if (project) {
      await db.saveProjectInfo({ ...project, lastBuildStatus: status });
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
  const deployments = await db.getDeployments();
  const existing = deployments.find((d: any) => d.id === deploymentId);
  await db.saveDeploymentInfo({
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
  const user = await db.getUserById(ownerId)
  if (!user || user.defaultModelId) return
  await db.saveUser({ ...user, defaultModelId: deploymentId })
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
  io: SocketServer | undefined
  client!: Client
  masterKey: string
  clusterService?: ClusterService
  headscale?: { createPreAuthKey(userId: string, opts?: { reusable?: boolean; expirySeconds?: number }): Promise<{ key: string }> }

  lastConsolidation?: ConsolidationReport

  constructor(
    db: Database,
    io?: SocketServer,
    masterKey?: string,
    clusterService?: ClusterService,
    headscale?: { createPreAuthKey(userId: string, opts?: { reusable?: boolean; expirySeconds?: number }): Promise<{ key: string }> },
  ) {
    this.db = db
    this.io = io
    this.masterKey = masterKey || ''
    if (clusterService !== undefined) this.clusterService = clusterService
    if (headscale !== undefined) this.headscale = headscale
  }

  isReady(): boolean {
    return !!this.client
  }

  private async getClusterById(id: string): Promise<ClusterMetadata | undefined> {
    if (id === 'provisioning-lunorica' && this.clusterService) {
      return this.clusterService.getSystemClusterEntry();
    }
    const clusters = await this.db.getClusters();
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
    let consecutiveFailures = 0
    const timer = setInterval(async () => {
      try {
        const status = await pollWorkflowRun(wfId)
        consecutiveFailures = 0

        if (status && status.status?.name !== 'RUNNING') {
          clearInterval(timer)
          const name = status.status?.name
          let kubeconfig: string | undefined
          if (name === 'COMPLETED' && action === 'cluster-provision') {
            try {
              const handle = this.client.workflow.getHandle(wfId)
              const wfResult = await handle.result()
              kubeconfig = (wfResult as any).kubeconfig
              const meshIp = (wfResult as any).meshIp
              if (meshIp) {
                const current = (await this.db.getClusters()).find((c: ClusterMetadata) => c.id === resourceId)
                await this.db.saveClusterInfo({ ...(current ?? {}), id: resourceId, name: resourceName, provider, meshIp } as any)
              }
              const vmHost = (wfResult as any).createdHost
              if (vmHost) {
                const current = (await this.db.getClusters()).find((c: ClusterMetadata) => c.id === resourceId)
                await this.db.saveClusterInfo({
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
                const current = (await this.db.getClusters()).find((c: ClusterMetadata) => c.id === resourceId)
                await this.db.saveClusterInfo({ ...(current ?? {}), id: resourceId, name: resourceName, provider, capacity } as any)
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
              await this.db.deleteDeployment(resourceId)
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
                const [projects, runs] = await Promise.all([this.db.getProjects(), this.db.getPipelineRuns()])
                const run = runs.find((r: any) => r.id === resourceId)
                const project = run && projects.find((p: any) => p.id === run.projectId)
                if (project?.autoDeployOnBuild && run) {
                  await this.promoteProjectBuild(project, run)
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
          console.error(`[TemporalBridge] Workflow ${wfId} polling failed ${consecutiveFailures} times — giving up`)
        } else {
          console.warn(`[TemporalBridge] Failed polling workflow ${wfId} (${consecutiveFailures}/${MAX_POLL_FAILURES}): ${err.message}`)
        }
      }
    }, WORKFLOW_POLL_INTERVAL)
  }

  async startLeaf(leaf: { id: string; title: string; column: string; depth: number }): Promise<string | undefined> {
    if (!this.client) return undefined
    const workflowId = `leaf-${leaf.id}`
    try {
      await this.client.workflow.start(LeafWorkflow, {
        workflowId,
        taskQueue: HOST_QUEUE,
        args: [{ leafId: leaf.id, title: leaf.title, column: leaf.column as any, depth: leaf.depth }],
      })
      return workflowId
    } catch (err: any) {
      if (/already started/i.test(err?.message ?? '')) return workflowId
      console.warn(`[TemporalBridge] Could not start leaf workflow ${workflowId}: ${err.message}`)
      return undefined
    }
  }

  async planProject(treeId: string, branchId: string): Promise<string | undefined> {
    if (!this.client) return undefined
    const workflowId = `plan-${treeId}`
    try {
      await this.client.workflow.start(ProjectPlanWorkflow, {
        workflowId,
        taskQueue: HOST_QUEUE,
        args: [{ treeId, branchId }],
      })
      return workflowId
    } catch (err: any) {
      if (/already started/i.test(err?.message ?? '')) return workflowId
      console.warn(`[TemporalBridge] Could not start planning workflow ${workflowId}: ${err.message}`)
      return undefined
    }
  }

  async signalLeaf(leafId: string, signal: 'moveLeaf' | 'cancelLeaf' | 'completeLeaf' | 'addChild', payload?: unknown): Promise<boolean> {
    if (!this.client) return false
    try {
      const handle = this.client.workflow.getHandle(`leaf-${leafId}`)
      await handle.signal(signal, ...(payload === undefined ? [] : [payload]))
      return true
    } catch (err: any) {
      console.warn(`[TemporalBridge] Could not signal leaf ${leafId} (${signal}): ${err.message}`)
      return false
    }
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

    const clusters = await this.db.getClusters()
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

    const deployments = await this.db.getDeployments()
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
        const clusters = await this.db.getClusters()
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
              await this.db.updateClusterProgress(cluster.id, progress)
            }
          }
        }

        const deployments = await this.db.getDeployments()

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
            const namespace = sanitizeNamespace(dep.name)
            const raw = await new InfrastructureService().runKubectl(['get', 'pods', '-n', namespace, '-o', 'json'], kubeconfig)
            const { health, reason } = assessWorkload(JSON.parse(raw))

            let serviceReason = ''
            if (health === 'healthy' && looksLikeMcp(dep) && dep.ownerId) {
              try {
                const registry = new McpRegistryService(this.db, dep.ownerId, (n: string) => resolveMcpProbeUrl(n))
                const found = (await registry.listWithTools()).find((s) => s.id === dep.id)
                const verdict = healthFromProbe(found ? { unreachable: found.unreachable, tools: found.tools.length } : undefined)
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
              await this.db.deleteDeployment(dep.id)
            }
            if (this.io) this.io.emit('deployment-updated')
          }
        }
      } catch (err: any) {
        console.warn(`[Reconcile] Error: ${err.message}`)
      }

    }

    const releaseBackstop = async () => {
    try {
      const leaves = await this.db.getLeaves()
      for (const leaf of readyToStart(leaves)) {
        const workflowId = await this.startLeaf(leaf)
        if (!workflowId) continue
        await this.db.saveLeaf({ ...leaf, workflowId, updatedAt: new Date().toISOString() })
        console.warn(`[Reconcile] BACKSTOP started "${leaf.title}" — its dependencies completed but nothing woke it. A leaf workflow was probably terminated.`)
        if (this.io) this.io.emit('leaf-updated')
      }
    } catch (err: any) {
      console.warn(`[Reconcile] Could not release waiting leaves: ${err.message}`)
    }
  }

    const reconcileRuns = async () => {
      if (!this.client) return
      try {
        const runs = await this.db.getPipelineRuns()
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
          await this.db.savePipelineRunInfo({ ...run, status: next })
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
        const memories = await this.db.getMemories().catch(() => [])
        const ownerId = memories[0]?.ownerId
        const ends = ownerId ? await corpusEndpoints(this.db, ownerId).catch(() => undefined) : undefined

        const report = await consolidateMemories({
          db: this.db as never,
          ...(ends ? {
            index: (items) => indexMemories(ends, items),
            similar: async (ids: string[]) => {
              const out = new Map<string, { id: string; score: number }[]>()
              for (const id of ids) {
                out.set(id, await similarTo(ends, id, { ownerId: ownerId! }).catch(() => []))
              }
              return out
            },
          } : {}),
        })

        if (report.deduped || report.promoted || report.decayed) {
          console.log(`[Consolidate] ${report.live} live memories`
            + ` (deduped ${report.deduped}, promoted ${report.promoted}, decayed ${report.decayed},`
            + ` indexed ${report.indexed})`)
        }
        this.lastConsolidation = report
      } catch (err: any) {
        console.warn(`[Consolidate] pass failed: ${err.message}`)
      } finally {
        consolidating = false
      }
    }

    const reconcileLeaves = async () => {
      if (!this.client) return
      try {
        const leaves = await this.db.getLeaves()
        for (const leaf of leaves) {
          if (!(LIVE_LEAF_STATUSES as readonly string[]).includes(leaf.status)) continue
          if (!leaf.workflowId) continue

          const attempts = (leaf.attempts ?? []).length
          let decision: LeafReconcileAction | undefined
          try {
            const described = await pollWorkflowRun(leaf.workflowId)
            decision = reconcileLeaf(leaf.status, described?.status?.name, attempts)
          } catch (err: any) {
            if (!/not\s*found/i.test(String(err?.message ?? err))) continue
            decision = reconcileMissingLeafWorkflow(leaf.status, leaf.updatedAt, attempts)
          }
          if (!decision) continue

          const fresh = (await this.db.getLeaves()).find((l) => l.id === leaf.id)
          if (!fresh || fresh.status !== leaf.status) continue

          if (decision.action === 'restart') {
            const { workflowId: _dead, ...withoutWorkflow } = fresh
            await this.db.saveLeaf({ ...withoutWorkflow, updatedAt: new Date().toISOString() })
            console.warn(`[Reconcile] leaf ${leaf.id.slice(0, 8)}: ${decision.reason}`)
          } else {
            await this.db.saveLeaf({
              ...fresh,
              status: 'failed',
              attempts: [...(fresh.attempts ?? []), {
                attempt: attempts,
                error: decision.reason,
                failedAt: new Date().toISOString(),
                produced: false,
              }],
              updatedAt: new Date().toISOString(),
            })
            console.warn(`[Reconcile] leaf ${leaf.id.slice(0, 8)} -> failed: ${decision.reason}`)
          }
          if (this.io) this.io.emit('leaves-updated')
        }
      } catch (err: any) {
        console.warn(`[Reconcile] Could not reconcile leaves: ${err.message}`)
      }
    }

    reconcile()
    setInterval(reconcile, RECONCILE_INTERVAL)
    consolidate()
    setInterval(consolidate, CONSOLIDATE_INTERVAL)
    reconcileRuns()
    setInterval(reconcileRuns, RECONCILE_INTERVAL)
    reconcileLeaves()
    setInterval(reconcileLeaves, RECONCILE_INTERVAL)
    releaseBackstop()
    setInterval(releaseBackstop, DEPENDENCY_BACKSTOP_INTERVAL)
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
      const user = await this.db.getUserById(userId)
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
      const user = await this.db.getUserById(userId)
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

    const savedCluster = await this.db.saveClusterInfo({
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

    const handle = await this.client.workflow.start(ClusterProvisionWorkflow, {
      workflowId: wfId,
      taskQueue: HOST_QUEUE,
      args: [activityArgs],
    })

    this.trackWorkflow(wfId, 'cluster-provision', savedCluster.id, clusterName, provider)

    return {
      id: wfId,
      resourceId: savedCluster.id,
      event: 'cluster-provision',
    }
  }

async destroyCluster(clusterId: string): Promise<WorkflowDeal> {
  const clusters = await this.db.getClusters()
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

    this.db.saveClusterInfo({
      ...cluster,
      status: 'destroying',
      temporalWorkflowId: wfId,
      lastLogPath: absoluteLogPath,
    })

    const handle = await this.client.workflow.start(executeDestroyClusterWorkflow, {
      workflowId: wfId,
      taskQueue: HOST_QUEUE,
      args: [activityArgs],
    })

    this.trackWorkflow(wfId, 'cluster-destroy', cluster.id, cluster.name, cluster.provider)

    return {
      id: wfId,
      event: 'cluster-destroy',
    }
  }

  private resolveOpenaiApiBaseUrl(dep: DeploymentMetadata, allDeployments: DeploymentMetadata[]): string | undefined {
    const targetId = dep.appType === 'hermes' ? dep.hermesTargetId : (dep.appType === 'openwebui' ? dep.openWebuiTargetId : undefined);
    if (!targetId) return undefined;
    const target = allDeployments.find((d) => d.id === targetId);
    if (!target) return undefined;
    if (target.clusterId !== dep.clusterId) {
      console.warn(`[TemporalBridge] Open WebUI deployment "${dep.name}" targets "${target.name}" on a different cluster — skipping OPENAI_API_BASE_URL, it must be configured manually.`);
      return undefined;
    }
    if (target.appType !== 'vllm' && target.appType !== 'tabbyapi') return undefined;
    const sanitize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const targetNs = sanitize(target.name);
    return target.appType === 'tabbyapi'
      ? `http://${targetNs}-tabbyapi.${targetNs}.svc.cluster.local:5000/v1`
      : `http://${targetNs}-vllm.${targetNs}.svc.cluster.local:8000/v1`;
  }

  async deployApp(config: any, userId?: string): Promise<WorkflowDeal> {
    if (userId) {
      const cluster = (await this.db.getClusters()).find((c: ClusterMetadata) => c.id === config.clusterId)
      const appType = config.appType || 'odoo'
      const problem = checkCapacity(appType, cluster?.capacity, requestedGpuCount(appType, config))
      if (problem) throw new CapacityError(problem)
    }

    const unresolved = await this.db.getDeployments()
    let [dep] = unresolved.filter((d: DeploymentMetadata) => {
      if (config.name && d.name === config.name && d.clusterId === config.clusterId) return true
      if (config.id && d.id === config.id) return true
      return false
    })
    if (!dep) {
      dep = {
        status: 'deploying',
        id: config.id || config.name,
        name: config.name,
        clusterId: config.clusterId,
        strategy: config.strategy || 'helm',
        appType: config.appType || 'odoo',
        modules: config.modules || [],
        storage: config.storage || {},
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
        ...(userId !== undefined ? { ownerId: userId } : {}),
      }
      dep = resolveVllmDefaults(dep as DeploymentMetadata)
      dep = resolveTabbyDefaults(dep as DeploymentMetadata)
      dep = resolveCrawl4aiDefaults(dep as DeploymentMetadata)
      dep = resolveSearxngDefaults(dep as DeploymentMetadata)
      dep = resolveMinioDefaults(dep as DeploymentMetadata)
      dep = resolveQdrantDefaults(dep as DeploymentMetadata)
      dep = resolveQuickwitDefaults(dep as DeploymentMetadata, await this.db.getDeployments())
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

    const openaiApiBaseUrl = this.resolveOpenaiApiBaseUrl(dep, unresolved);

    if (!dep.vllmHfToken && !dep.tabbyHfToken && (dep.appType === 'vllm' || config.appType === 'vllm' || dep.appType === 'tabbyapi' || config.appType === 'tabbyapi')) {
      let userCreds;
      if (userId) {
        const user = await this.db.getUserById(userId);
        const encryptedToken = user?.credentials?.huggingface?.hfToken;
        if (encryptedToken) {
          try {
            userCreds = { huggingface: { hfToken: decryptValue(encryptedToken, this.masterKey) } };
          } catch { /* ignored */ }
        }
      }
      const resolved = resolveCloudCredentials('huggingface', userCreds);
      if (resolved.env.HF_TOKEN) {
        if (dep.appType === 'tabbyapi') {
          dep.tabbyHfToken = resolved.env.HF_TOKEN;
        } else {
          dep.vllmHfToken = resolved.env.HF_TOKEN;
        }
      }
    }

  const targetCluster = await this.getClusterById(dep.clusterId)
  const wfId = `app-deploy-${dep.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const logFileName = `${Date.now()}-${Math.random().toString(36).slice(2)}-C3.log`
  const absoluteLogPath = path.join(LOG_DIR, logFileName)
  const deploymentId = deploymentIdFor(dep.deploymentId, dep.id || dep.name);
  dep.deploymentId = deploymentId;

    const activityArgs = {
      name: dep.name,
      clusterId: dep.clusterId,
      clusterName: targetCluster?.name || 'unknown',
      provider: targetCluster?.provider || 'k3d',
      ...(dep.appType === 'tabbyapi' && targetCluster?.isSystem
        ? { modelCacheHostPath: resolveTabbyCacheHostPath(dep.tabbyCachePvc) }
        : {}),
      ...(dep.appType === 'vllm' && targetCluster?.isSystem
        ? { modelCacheHostPath: resolveVllmCacheHostPath(dep.vllmCachePvc) }
        : {}),
      ...(targetCluster?.gpuEnabled !== undefined ? { clusterGpuEnabled: targetCluster.gpuEnabled } : {}),
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

    this.db.saveDeploymentInfo({
      ...dep,
      id: dep.id || dep.name,
      status: 'deploying',
      healthReason: '',
      temporalWorkflowId: wfId,
      lastLogPath: absoluteLogPath,
    })

    const handle = await this.client.workflow.start(executeDeployAppWorkflow, {
      workflowId: wfId,
      taskQueue: CLUSTER_QUEUE,
      args: [activityArgs],
    })

    this.trackWorkflow(wfId, 'app-deploy', dep.id, dep.name, '', dep)

    return {
      id: wfId,
      resourceId: dep.id,
      event: 'app-deploy',
    }
  }

  async destroyApp(deploymentId: string): Promise<WorkflowDeal> {
    const deployments = await this.db.getDeployments()
    const [dep] = deployments.filter((d: DeploymentMetadata) => d.id === deploymentId)
    if (!dep) throw new Error('DeploymentMetadata not found (destroyApp)')

    const cluster = await this.getClusterById(dep.clusterId)
    const wfId = `app-destroy-${dep.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const logFileName = `${Date.now()}-${Math.random().toString(36).slice(2)}-D4.log`
    const absoluteLogPath = path.join(LOG_DIR, logFileName)

    const activityArgs = {
      name: dep.name,
      clusterId: dep.clusterId,
      clusterName: cluster?.name || 'unknown',
      provider: cluster?.provider || 'k3d',
      strategy: dep.strategy || 'helm',
      logFile: absoluteLogPath,
      deploymentId: dep.deploymentId || 'default',
    }

     this.db.saveDeploymentInfo({
      ...dep,
      status: 'destroying',
      temporalWorkflowId: wfId,
      lastLogPath: absoluteLogPath,
    })

    const handle = await this.client.workflow.start(executeDestroyAppWorkflow, {
      workflowId: wfId,
      taskQueue: CLUSTER_QUEUE,
      args: [activityArgs],
    })

    this.trackWorkflow(wfId, 'app-destroy', dep.id, dep.name, '', dep)

    return {
      id: wfId,
      event: 'app-destroy',
    }
  }

  async resizeDisk(deploymentId: string, storage: Record<string, string>): Promise<WorkflowDeal> {
    const deployments = await this.db.getDeployments()
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

    this.db.saveDeploymentInfo({
      ...dep,
      storage: { ...dep.storage, ...storage },
      status: 'deploying',
      healthReason: '',
      temporalWorkflowId: wfId,
      lastLogPath: absoluteLogPath,
    })

    const handle = await this.client.workflow.start(executeResizeDiskWorkflow, {
      workflowId: wfId,
      taskQueue: CLUSTER_QUEUE,
      args: [activityArgs],
    })

    this.trackWorkflow(wfId, 'app-resize', dep.id, dep.name, '', { ...dep, newStorage: storage })

    return {
      id: wfId,
      event: 'disk-resize',
    }
  }

  async syncConfig(deploymentId: string): Promise<WorkflowDeal> {
    const deployments = await this.db.getDeployments()
    let [dep] = deployments.filter((d: DeploymentMetadata) => d.id === deploymentId)
    if (!dep) throw new Error('DeploymentMetadata not found (syncConfig)')
    dep = resolveVllmDefaults(dep)
    dep = resolveTabbyDefaults(dep)
    dep = resolveCrawl4aiDefaults(dep)
    dep = resolveSearxngDefaults(dep)
    dep = resolveMinioDefaults(dep)
    dep = resolveQdrantDefaults(dep)
    dep = resolveQuickwitDefaults(dep, deployments)
    dep = resolveAppSettingsDefaults(dep)

    const openaiApiBaseUrl = this.resolveOpenaiApiBaseUrl(dep, deployments);

    const cluster = await this.getClusterById(dep.clusterId)
    const wfId = `sync-config-${dep.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const logFileName = `${Date.now()}-${Math.random().toString(36).slice(2)}-G7.log`
    const absoluteLogPath = path.join(LOG_DIR, logFileName)

    const activityArgs = {
      name: dep.name,
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

    this.db.saveDeploymentInfo({
      ...dep,
      status: 'deploying',
      healthReason: '',
      temporalWorkflowId: wfId,
      lastLogPath: absoluteLogPath,
    })

    const handle = await this.client.workflow.start(executeSyncConfigWorkflow, {
      workflowId: wfId,
      taskQueue: CLUSTER_QUEUE,
      args: [activityArgs],
    })

    this.trackWorkflow(wfId, 'app-sync-config', dep.id, dep.name, '', dep)

    return {
      id: wfId,
      event: 'config-sync',
    }
  }

  async updateConfigAndSync(deploymentId: string, patch: Partial<DeploymentMetadata>): Promise<WorkflowDeal> {
    const deployments = await this.db.getDeployments()
    const dep = deployments.find((d: DeploymentMetadata) => d.id === deploymentId)
    if (!dep) throw new Error('DeploymentMetadata not found (updateConfigAndSync)')

    const merged: Record<string, any> = { ...dep, ...patch }
    for (const field of DEEP_MERGE_FIELDS) {
      const incoming = (patch as Record<string, any>)[field]
      if (incoming) {
        merged[field] = { ...((dep as Record<string, any>)[field] ?? {}), ...incoming }
      }
    }
    await this.db.saveDeploymentInfo(merged)

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

  async onClusterStatus(query: string): Promise<ClusterMetadata[]> {
    return this.db.getClusters()
  }

  async onClusterStatusClearup(clusterId: string): Promise<void> {
    const deployments = await this.db.getDeployments()
    const arr = deployments.filter((d: any) => d.clusterId !== clusterId)
    await this.db.saveDeploymentList(arr)
  }

  async runPipeline(project: ProjectMetadata, commitSha: string, ref: string): Promise<WorkflowDeal> {
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

    await this.db.savePipelineRunInfo({
      id: runId,
      projectId: project.id,
      commitSha,
      ref,
      status: 'queued',
      logFile: absoluteLogPath,
      temporalWorkflowId: wfId,
      startedAt: new Date().toISOString(),
    })
    await this.db.saveProjectInfo({ ...project, lastBuildStatus: 'queued' })

    const handle = await this.client.workflow.start(executePipelineRunWorkflow, {
      workflowId: wfId,
      taskQueue: CLUSTER_QUEUE,
      args: [activityArgs],
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
    if (!run.imageTag) throw new Error('Pipeline run has no built image to promote');
    if (!project.targetClusterId) throw new Error('Project has no target cluster configured');

    const lastColon = run.imageTag.lastIndexOf(':');
    const odooRepo = run.imageTag.slice(0, lastColon);
    const odooTag = run.imageTag.slice(lastColon + 1);

    return this.deployApp({
      name: project.name,
      clusterId: project.targetClusterId,
      strategy: 'native',
      appType: 'gitapp',
      odooRepo,
      odooTag,
      storage: {},
      gitappProjectId: project.id,
      gitappImageTag: run.imageTag,
      ...(project.deployEnv ? { gitappEnv: project.deployEnv } : {}),
    }, userId);
  }
}
