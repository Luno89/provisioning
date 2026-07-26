/**
 * Temporal Bridge - bridges Express routes ↔ Temporal workflow execution.
 *
 * All provisioning / deployment mutations go through this bridge, replacing the
 * original inline setTimeout() loops with Temporal's workflow persistence engine.
 *
 * Each method:
 *   1. Builds a unique workflowId
 *   2. Prepares the args array from the DB (cluster, deployment, etc.)
 *   3. Calls client.workflow.start(workflowFn, { workflowId, taskQueue, args: [args] })
 *   4. Returns a WorkflowDeal
 */
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import type { Client } from '@temporalio/client'

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_DIR = path.resolve(__dirname, '../../data/logs');
import { getTemporalClient, pollWorkflowRun } from '../lib/temporal-client.js'
import { resolveCloudCredentials } from '../lib/credential-resolver.js'
import { decryptValue, encryptValue } from '../lib/crypto.js'
import type { Database } from '../lib/db-interface.js'
import type { ClusterMetadata, ClusterProgress, DeploymentMetadata, ProjectMetadata, PipelineRunMetadata } from '../lib/types.js'
import type { ClusterService } from './ClusterService.js'
import { ClusterProvisionWorkflow } from '../workflows/ClusterProvisionWorkflow.js'
import { executeDestroyClusterWorkflow } from '../workflows/DestroyClusterWorkflow.js'
import { executeDeployAppWorkflow } from '../workflows/AppDeployWorkflow.js'
import { executeDestroyAppWorkflow } from '../workflows/DestroyAppWorkflow.js'
import { executeResizeDiskWorkflow } from '../workflows/ResizeDiskWorkflow.js'
import { executeSyncConfigWorkflow } from '../workflows/SyncConfigWorkflow.js'
import { executePipelineRunWorkflow } from '../workflows/PipelineRunWorkflow.js'
import { resolveVllmDefaults, resolveTabbyDefaults } from '../lib/app-env.js'
import { resolveTabbyCacheHostPath } from '../lib/tabby-cache-path.js'
import type { Server as SocketServer } from 'socket.io'

const HOST_QUEUE = 'host-ops-queue'
const CLUSTER_QUEUE = 'cluster-ops-queue'
const WORKFLOW_POLL_INTERVAL = 5000
const RECONCILE_INTERVAL = 30000
const MAX_POLL_FAILURES = 12

export interface WorkflowDeal {
  readonly id: string
  readonly resourceId?: string
  readonly event: string
}

// ────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────

async function getDefaultClient(address?: string): Promise<Client> {
  return getTemporalClient({ address })
}

async function updateUserStatus(
  db: Database,
  clusterId: string,
  clusterName: string,
  provider: string,
  status: string,
  kubeconfigPath?: string,
): Promise<void> {
  const clusters = await db.getClusters();
  const existing = clusters.find((c: any) => c.id === clusterId);
  // Spread `existing` first rather than naming individual carry-forward fields. db.saveCluster is
  // a full replaceOne, so anything omitted here is DELETED from the record — and this function
  // runs on every status transition. Listing fields by hand silently dropped the whole remote*
  // group (host/username/encrypted key), which meant a 'remote' cluster lost its SSH details the
  // moment it went healthy and could never be cleanly torn down again. For 'hetzner' the same
  // omission would orphan a running, billing VM with nothing left pointing at it.
  return db.saveClusterInfo({
    ...(existing ?? {}),
    id: clusterId,
    name: clusterName,
    provider,
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
  status: string,
  storage = undefined,
): Promise<void> {
  const deployments = await db.getDeployments();
  const existing = deployments.find((d: any) => d.id === deploymentId);
  return db.saveDeploymentInfo({
    id: deploymentId,
    name: deployment.name,
    clusterId: deployment.clusterId,
    strategy: deployment.strategy,
    appType: deployment.appType,
    status,
    modules: deployment.modules,
    storage,
    temporalWorkflowId: existing?.temporalWorkflowId,
    url: deployment.url,
    lastLogPath: existing?.lastLogPath ?? deployment.lastLogPath,
    deploymentId: existing?.deploymentId ?? deployment.deploymentId,
    ownerId: existing?.ownerId ?? deployment.ownerId,
  })
}

// ────────────────────────────────────────────────────────────────────
// Bridge implementation
// ────────────────────────────────────────────────────────────────────

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
            if (timeMatch) lastTimestamp = timeMatch[1]
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
  io?: SocketServer
  client!: Client
  masterKey: string
  clusterService?: ClusterService

  constructor(db: Database, io?: SocketServer, masterKey?: string, clusterService?: ClusterService) {
    this.db = db
    this.io = io
    this.masterKey = masterKey || ''
    if (clusterService !== undefined) this.clusterService = clusterService
  }

  isReady(): boolean {
    return !!this.client
  }

  /**
   * Resolves a cluster by id, including the synthetic system-cluster entry (see
   * ClusterService.getSystemClusterEntry) — which never lives in the real DB, so a raw
   * `db.getClusters().find(...)` silently misses it. Bypassing this is exactly what caused
   * deployApp() to lose track of `gpuEnabled` for apps deployed onto the system cluster,
   * re-triggering the k3d image-import bug that gate was supposed to prevent.
   */
  private async getClusterById(id: string): Promise<ClusterMetadata | undefined> {
    // Deliberately a raw DB read, not ClusterService.getById's ownership-checked lookup (it now
    // requires a userId) — this is an internal lookup for connection details (kubeconfig,
    // provider, gpuEnabled) during operations the *route* layer already authorized before ever
    // calling into TemporalBridge (deployApp/destroyApp/resizeDisk/updateConfigAndSync all
    // resolve the requesting user's id from requireAuth first). Re-checking ownership again this
    // deep would just mean threading userId through every TemporalBridge entry point for no
    // additional safety — the real per-user boundary is enforced once, at the route.
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
    // no-op in production mode
  }

  async stop(): Promise<void> {
    try {
      await this.client.close()
    } catch {
      // ignore
    }
  }

  trackWorkflow(
    wfId: string,
    action: 'cluster-provision' | 'cluster-destroy' | 'app-deploy' | 'app-destroy' | 'app-resize' | 'app-sync-config' | 'pipeline-run',
    resourceId: string,
    resourceName: string,
    provider: string,
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
              // A 'hetzner' cluster only learns its VM's identity here — the machine didn't exist
              // when the cluster row was written. Persisted before the status flips to 'healthy'
              // so a destroy triggered immediately afterwards can always find the VM; without
              // this the server would keep running (and billing) with nothing pointing at it.
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
                } as any)
              }
            } catch {}
          }
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
              await updateDeploymentStatus(this.db, resourceId, meta, 'running', meta?.storage)
            }
            if (this.io) this.io.emit('deployment-updated')
          } else if (action === 'app-destroy') {
            if (name === 'FAILED') {
              await updateDeploymentStatus(this.db, resourceId, meta, 'failed', meta?.storage)
            } else if (name === 'TERMINATED' || name === 'CANCELLED' || name === 'COMPLETED') {
              const deployments = await this.db.getDeployments()
              const arr = deployments.filter((d: any) => d.id !== resourceId)
              await this.db.saveDeploymentList(arr)
            }
            if (this.io) this.io.emit('deployment-updated')
          } else if (action === 'app-resize') {
            const newStorage = { ...meta?.storage, ...meta?.newStorage }
            if (name === 'FAILED') {
              await updateDeploymentStatus(this.db, resourceId, meta, 'failed', meta?.storage)
            } else if (name === 'TERMINATED' || name === 'CANCELLED') {
              await updateDeploymentStatus(this.db, resourceId, meta, 'failed', meta?.storage)
            } else if (name === 'COMPLETED') {
              await updateDeploymentStatus(this.db, resourceId, meta, 'running', newStorage)
            }
            if (this.io) this.io.emit('deployment-updated')
          } else if (action === 'app-sync-config') {
            if (name === 'FAILED' || name === 'TERMINATED' || name === 'CANCELLED') {
              await updateDeploymentStatus(this.db, resourceId, meta, 'failed', meta?.storage)
            } else if (name === 'COMPLETED') {
              await updateDeploymentStatus(this.db, resourceId, meta, 'running', meta?.storage)
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

    // 1. Recover Clusters
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

    // 2. Recover Deployments
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

    // 3. Start background reconciliation loop
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

          // Check Temporal workflow status
          const wfStatus = await pollWorkflowRun(wfId)
          const statusName = wfStatus?.status?.name
          if (!statusName) continue

          // Workflow has completed but DB wasn't updated — reconcile
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

          // Update progress from log file
          if (statusName === 'RUNNING' && cluster.lastLogPath) {
            const progress = inferProgressFromLog(cluster.lastLogPath)
            if (progress) {
              await this.db.updateClusterProgress(cluster.id, progress)
            }
          }
        }

        // Reconcile deployments
        const deployments = await this.db.getDeployments()
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
                await updateDeploymentStatus(this.db, dep.id, dep, 'running', dep.storage)
              }
            } else {
              const allDeployments = await this.db.getDeployments()
              await this.db.saveDeploymentList(allDeployments.filter((d: any) => d.id !== dep.id))
            }
            if (this.io) this.io.emit('deployment-updated')
          }
        }
      } catch (err: any) {
        console.warn(`[Reconcile] Error: ${err.message}`)
      }
    }

    reconcile()
    setInterval(reconcile, RECONCILE_INTERVAL)
  }

  // ────────────────────────────────────────────────────────────────────
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

  /**
   * Resolves a user's Hetzner Cloud token through the standard chain (user-stored → process.env),
   * decrypting the stored blob here because activities have no access to the DB or masterKey —
   * the same rule that governs remoteSshPrivateKey. Returns undefined when nothing is configured,
   * which the 'hetzner' branches turn into a clear error rather than a mock-cloud fallback.
   */
  private async resolveHetznerToken(userId?: string): Promise<string | undefined> {
    let userCreds: any
    if (userId) {
      const user = await this.db.getUserById(userId)
      const enc = (user?.credentials as any)?.hetzner?.token
      if (enc) {
        try {
          userCreds = { hetzner: { token: decryptValue(enc, this.masterKey) } }
        } catch {
          // Corrupt blob or rotated masterKey — fall through to the env-var link in the chain.
        }
      }
    }
    return resolveCloudCredentials('hetzner', userCreds).env.HCLOUD_TOKEN
  }

  async provision(
    clusterName: string,
    provider: string,
    userId: string,
    remote?: { host: string; username: string; privateKey: string; port?: number; k3sApiPort?: number },
    hetzner?: { serverType?: string; location?: string; image?: string },
  ): Promise<WorkflowDeal> {
    // GPU passthrough is exclusively provided by the always-on system cluster (native k3s —
    // k3d's nested containerd can't do device passthrough at all, see AGENTS.md). User-created
    // clusters are never GPU-enabled; there used to be a "flag this k3d cluster as GPU" path
    // that only ever silently pointed back at the system cluster's own kubeconfig under a
    // second name — removed as confusing and redundant with the system cluster entry itself.
    const wfId = `cluster-provision-${clusterName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const logFileName = `${Date.now()}-${Math.random().toString(36).slice(2)}-A1.log`
    const absoluteLogPath = path.join(LOG_DIR, logFileName)
    const hcloudToken = provider === 'hetzner' ? await this.resolveHetznerToken(userId) : undefined
    if (provider === 'hetzner' && !hcloudToken) {
      // Fail here rather than inside the workflow: this is a user-fixable configuration problem,
      // and surfacing it as an immediate API error beats a cluster row stuck in 'provisioning'
      // until an activity times out.
      throw new Error('No Hetzner Cloud API token configured — add one under Cloud Accounts first')
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
    }

    // Persist cluster row — the SSH private key is encrypted at rest (see ClusterMetadata's
    // remoteSshPrivateKeyEnc doc comment) and only ever decrypted again inside destroyCluster()
    // below, right before it's needed to SSH in and uninstall k3s.
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
      // Recorded up front so the cluster page can show what was requested while it provisions;
      // the VM's actual identity (id, IP, key) only arrives when the workflow completes.
      ...(hetzner?.serverType ? { hetznerServerType: hetzner.serverType } : {}),
      ...(hetzner?.location ? { hetznerLocation: hetzner.location } : {}),
      ...(hetzner?.image ? { hetznerImage: hetzner.image } : {}),
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

    const logFileName = `${Date.now()}-destroy-${Math.random().toString(36).slice(2)}-B2.log`
    const absoluteLogPath = path.join(LOG_DIR, logFileName)
    const hcloudToken = cluster.provider === 'hetzner' ? await this.resolveHetznerToken(cluster.ownerId) : undefined
    if (cluster.provider === 'hetzner' && !hcloudToken) {
      // Refusing outright is the safe failure here: marking the cluster 'destroyed' without a
      // token would hide a VM that is still running and still being paid for.
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
      ...(cluster.hetznerServerId ? { hetznerServerId: cluster.hetznerServerId } : {}),
    }
    const wfId = `cluster-destroy-${cluster.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    // Spread `cluster` for the same reason updateUserStatus does — saveCluster is a full replace,
    // so a field-by-field write here would strip the VM's id/IP/key at the exact moment a failed
    // destroy would need them to be retried.
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

  // ────────────────────────────────────────────────────────────────────
  // Deployment lifecycle
  // ────────────────────────────────────────────────────────────────────

  // Open WebUI doesn't get pointed at a backend via a repo/tag the way other apps do — it needs
  // the target vLLM/TabbyAPI deployment's in-cluster Service DNS name, which only exists once
  // that deployment's own CDKTF apply has run (see vllm.ts / tabbyapi.ts: Service
  // `${sanitizedName}-vllm` / `${sanitizedName}-tabbyapi` in namespace `${sanitizedName}`,
  // sanitizedName === the deployment's own SANITIZE(name)). Resolved here (shared by deployApp
  // and syncConfig) rather than on the frontend so there's one source of truth for that naming
  // scheme instead of duplicating the sanitize regex.
  private resolveOpenaiApiBaseUrl(dep: DeploymentMetadata, allDeployments: DeploymentMetadata[]): string | undefined {
    if (dep.appType !== 'openwebui' || !dep.openWebuiTargetId) return undefined;
    const target = allDeployments.find((d) => d.id === dep.openWebuiTargetId);
    if (!target) return undefined;
    // .svc.cluster.local only resolves within the same cluster — the frontend already only
    // offers same-cluster vLLM/TabbyAPI deployments as backend choices, but a stale/direct API
    // call could still send a cross-cluster id. Better to sync without a preconfigured backend
    // (Open WebUI's own Admin Settings > Connections can point at any reachable URL at
    // runtime) than to silently wire in a DNS name that will never resolve.
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
    // Find deployment row by name + clusterId (since config is req.body — may have no DB id)
    const unresolved = await this.db.getDeployments()
    let [dep] = unresolved.filter((d: DeploymentMetadata) => {
      if (config.name && d.name === config.name && d.clusterId === config.clusterId) return true
      if (config.id && d.id === config.id) return true
      return false
    })
    if (!dep) {
      dep = {
        id: config.id || config.name,
        name: config.name,
        clusterId: config.clusterId,
        strategy: config.strategy || 'helm',
        appType: config.appType || 'odoo',
        modules: config.modules || [],
        storage: config.storage || {},
        // The deploy wizard posts these under the legacy odooRepo/odooTag/pgRepo/pgTag names
        // (a holdover from when this app only deployed Odoo) — webRepo/webTag/dbRepo/dbTag is
        // what CDKTF and every construct actually expects. Without this fallback, every
        // non-Odoo app type (WordPress, Nextcloud, ...) silently got an empty repo/tag here and
        // fell back to its construct's own hardcoded default image, ignoring whatever the user
        // picked in the wizard — Odoo alone masked this because DeployAppActivity has an
        // Odoo-specific hardcoded fallback ('library/odoo'/'18.0').
        webRepo: config.webRepo || config.odooRepo,
        webTag: config.webTag || config.odooTag,
        dbRepo: config.dbRepo || config.pgRepo,
        dbTag: config.dbTag || config.pgTag,
        url: config.url,
        vllmModel: config.vllmModel,
        vllmGpuCount: config.vllmGpuCount,
        vllmGpuVendor: config.vllmGpuVendor,
        vllmCachePvc: config.vllmCachePvc,
        // .trim(): a pasted token with a trailing space/newline is invisible in the wizard's
        // input field and passes every "Test Connection" check (fetch/curl tolerate it), but
        // fails outright against a strict HTTP client downstream — confirmed live: TabbyAPI's
        // own downloader uses Python's httpx, which rejects a Bearer header with trailing
        // whitespace as malformed before the request is even sent, and (due to a separate bug in
        // TabbyAPI itself swallowing that exception) fails every model download silently.
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
        tabbyExtraEnv: config.tabbyExtraEnv,
        openWebuiTargetId: config.openWebuiTargetId,
        webuiEnableWebSearch: config.webuiEnableWebSearch,
        webuiWebSearchEngine: config.webuiWebSearchEngine,
        webuiWebSearchApiKey: config.webuiWebSearchApiKey,
        ownerId: userId,
      }
      dep = resolveVllmDefaults(dep as DeploymentMetadata)
      dep = resolveTabbyDefaults(dep as DeploymentMetadata)
    }

    const openaiApiBaseUrl = this.resolveOpenaiApiBaseUrl(dep, unresolved);

    if (!dep.vllmHfToken && !dep.tabbyHfToken && (dep.appType === 'vllm' || config.appType === 'vllm' || dep.appType === 'tabbyapi' || config.appType === 'tabbyapi')) {
      let userCreds;
      if (userId) {
        const user = await this.db.getUserById(userId);
        const encryptedToken = user?.credentials?.huggingface?.hfToken;
        if (encryptedToken) {
          try {
            userCreds = { huggingface: { hfToken: decryptValue(encryptedToken, this.masterKey) } };
          } catch {
            // Corrupted ciphertext or wrong master key — fall through to env/mock
          }
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
  const deploymentId = dep.deploymentId || Math.random().toString(36).slice(2, 10);
  dep.deploymentId = deploymentId;

    const activityArgs = {
      name: dep.name,
      clusterId: dep.clusterId,
      clusterName: targetCluster?.name || 'unknown',
      provider: targetCluster?.provider || 'k3d',
      // Pre-download only where this process actually shares a filesystem with the K8s node —
      // see DownloadModelActivity.ts's own comment for why that's currently just the native-k3s
      // system cluster (TabbyAPI is GPU-only, and k3d can't do real GPU passthrough, so it never
      // runs anywhere else that would make this ambiguous). Left unset everywhere else;
      // AppDeployWorkflow.ts skips the pre-download step entirely when it's absent.
      ...(dep.appType === 'tabbyapi' && targetCluster?.isSystem
        ? { modelCacheHostPath: resolveTabbyCacheHostPath(dep.tabbyCachePvc) }
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
      tabbyExtraEnv: dep.tabbyExtraEnv,
      ...(openaiApiBaseUrl ? { openaiApiBaseUrl } : {}),
      webuiEnableWebSearch: dep.webuiEnableWebSearch,
      webuiWebSearchEngine: dep.webuiWebSearchEngine,
      webuiWebSearchApiKey: dep.webuiWebSearchApiKey,
    }

    this.db.saveDeploymentInfo({
      ...dep,
      id: dep.id || dep.name,
      status: 'deploying',
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

  // ────────────────────────────────────────────────────────────────────
  // Resize disk
  // ────────────────────────────────────────────────────────────────────

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
      tabbyExtraEnv: dep.tabbyExtraEnv,
      ...(openaiApiBaseUrl ? { openaiApiBaseUrl } : {}),
      webuiEnableWebSearch: dep.webuiEnableWebSearch,
      webuiWebSearchEngine: dep.webuiWebSearchEngine,
      webuiWebSearchApiKey: dep.webuiWebSearchApiKey,
    }

    this.db.saveDeploymentInfo({
      ...dep,
      status: 'deploying',
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

  // Merges an edited-config patch onto the EXISTING stored deployment (never a bare partial —
  // saveDeploymentInfo() reconstructs id/name/clusterId/strategy/status from defaults for
  // anything not present in what it's given, so passing just the changed fields would blank
  // out the rest of the row) and then re-applies it via syncConfig().
  async updateConfigAndSync(deploymentId: string, patch: Partial<DeploymentMetadata>): Promise<WorkflowDeal> {
    const deployments = await this.db.getDeployments()
    const dep = deployments.find((d: DeploymentMetadata) => d.id === deploymentId)
    if (!dep) throw new Error('DeploymentMetadata not found (updateConfigAndSync)')

    await this.db.saveDeploymentInfo({
      ...dep,
      ...patch,
      storage: patch.storage ? { ...dep.storage, ...patch.storage } : dep.storage,
    })

    return this.syncConfig(deploymentId)
  }

  // ────────────────────────────────────────────────────────────────────
  // Temporal monitoring / query
  // ────────────────────────────────────────────────────────────────────

  async listWorkflows(query?: string, pageSize?: number): Promise<any[]> {
    if (!this.isReady()) return [];
    try {
      const iter = this.client.workflow.list({ query, pageSize: pageSize || 50 });
      const workflows: any[] = [];
      for await (const wf of iter) {
        workflows.push({
          workflowId: wf.workflowId,
          runId: wf.runId,
          type: wf.type?.name || wf.type,
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
      const result = await this.client.workflow.count({ query });
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
        type: desc.type?.name || desc.type,
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

  // ────────────────────────────────────────────────────────────────────
  // Maintenance
  // ────────────────────────────────────────────────────────────────────

  async onClusterStatus(query: string): Promise<ClusterMetadata[]> {
    return this.db.getClusters()
  }

  async onClusterStatusClearup(clusterId: string): Promise<void> {
    const deployments = await this.db.getDeployments()
    const arr = deployments.filter((d: any) => d.clusterId !== clusterId)
    await this.db.saveDeploymentList(arr)
  }

  // ────────────────────────────────────────────────────────────────────
  // CI/CD pipeline runs (self-hosted Gitea webhook -> build -> push)
  // ────────────────────────────────────────────────────────────────────

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

  /**
   * Deploys (or redeploys) a project's built image — shared by the manual "promote" route and
   * the autoDeployOnBuild hook in trackWorkflow below. Reuses deployApp()'s own find-or-create
   * lookup (by name + clusterId) rather than distinguishing first-deploy vs redeploy itself —
   * calling this twice for the same project just redeploys the same DeploymentMetadata row.
   */
  async promoteProjectBuild(project: ProjectMetadata, run: PipelineRunMetadata, userId?: string): Promise<WorkflowDeal> {
    if (!run.imageTag) throw new Error('Pipeline run has no built image to promote');
    if (!project.targetClusterId) throw new Error('Project has no target cluster configured');

    const lastColon = run.imageTag.lastIndexOf(':');
    const odooRepo = run.imageTag.slice(0, lastColon); // "odooRepo"/"odooTag" is this platform's generic webRepo/webTag field name — see DeployAppActivity.ts
    const odooTag = run.imageTag.slice(lastColon + 1);

    return this.deployApp({
      name: project.name,
      clusterId: project.targetClusterId,
      strategy: 'native',
      appType: 'gitapp',
      odooRepo,
      odooTag,
      storage: {},
    }, userId);
  }
}
