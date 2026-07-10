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
import type { Client } from '@temporalio/client'

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_DIR = path.resolve(__dirname, '../../data/logs');
import { getTemporalClient, pollWorkflowRun } from '../lib/temporal-client.js'
import { LocalDB } from '../lib/db.js'
import type { ClusterMetadata, DeploymentMetadata } from '../lib/types.js'
import { ClusterProvisionWorkflow } from '../workflows/ClusterProvisionWorkflow.js'
import { executeDestroyClusterWorkflow } from '../workflows/DestroyClusterWorkflow.js'
import { executeDeployAppWorkflow } from '../workflows/AppDeployWorkflow.js'
import { executeDestroyAppWorkflow } from '../workflows/DestroyAppWorkflow.js'
import { executeResizeDiskWorkflow } from '../workflows/ResizeDiskWorkflow.js'
import type { Server as SocketServer } from 'socket.io'

const HOST_QUEUE = 'host-ops-queue'
const CLUSTER_QUEUE = 'cluster-ops-queue'
const WORKFLOW_POLL_INTERVAL = 5000

export interface WorkflowDeal {
  readonly id: string
  readonly resourceId?: string
  readonly event: string
  promise: Promise<any>
}

// ────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────

async function getDefaultClient(address?: string): Promise<Client> {
  return getTemporalClient({ address })
}

async function updateUserStatus(
  db: LocalDB,
  clusterId: string,
  clusterName: string,
  provider: string,
  status: string,
  kubeconfigPath?: string,
): Promise<void> {
  const clusters = await db.getClusters();
  const existing = clusters.find((c: any) => c.id === clusterId);
  return db.saveClusterInfo({
    id: clusterId,
    name: clusterName,
    provider,
    status,
    kubeconfigPath: kubeconfigPath ?? existing?.kubeconfigPath,
    temporalWorkflowId: existing?.temporalWorkflowId,
    lastLogPath: existing?.lastLogPath,
  })
}

async function updateDeploymentStatus(
  db: LocalDB,
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
  })
}

// ────────────────────────────────────────────────────────────────────
// Bridge implementation
// ────────────────────────────────────────────────────────────────────

export const connectToTemporal = async (address: string): Promise<Client> => {
  const c = await getDefaultClient(address)
  return c
}

export class TemporalBridge {
  db!: LocalDB
  io?: SocketServer
  client!: Client

  constructor(db: LocalDB, io?: SocketServer) {
    this.db = db
    this.io = io
  }

  isReady(): boolean {
    return !!this.client
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
    action: 'cluster-provision' | 'cluster-destroy' | 'app-deploy' | 'app-destroy' | 'app-resize',
    resourceId: string,
    resourceName: string,
    provider: string,
    meta?: any
  ) {
    const timer = setInterval(async () => {
      try {
        const status = await pollWorkflowRun(wfId)
        if (status && status.status?.name !== 'RUNNING') {
          clearInterval(timer)
          const name = status.status?.name
          let kubeconfig: string | undefined
          if (name === 'COMPLETED' && action === 'cluster-provision') {
            try {
              const handle = this.client.workflow.getHandle(wfId)
              const wfResult = await handle.result()
              kubeconfig = (wfResult as any).kubeconfig
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
          }
        }
      } catch (err: any) {
        console.warn(`[TemporalBridge] Failed polling workflow ${wfId}: ${err.message}`)
        clearInterval(timer)
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
  }

  // ────────────────────────────────────────────────────────────────────
  // Cluster lifecycle
  // ────────────────────────────────────────────────────────────────────

  async provision(clusterName: string, provider: string): Promise<WorkflowDeal> {
    const wfId = `cluster-provision-${clusterName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const logFileName = `${Date.now()}-${Math.random().toString(36).slice(2)}-A1.log`
    const absoluteLogPath = path.join(LOG_DIR, logFileName)
    const activityArgs = { name: clusterName, provider, logFile: absoluteLogPath }

    // Persist cluster row
    const savedCluster = await this.db.saveClusterInfo({
      name: clusterName,
      provider,
      status: 'provisioning',
      temporalWorkflowId: wfId,
      lastLogPath: absoluteLogPath,
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
      promise: handle.result(),
    }
  }

async destroyCluster(clusterId: string): Promise<WorkflowDeal> {
  const clusters = await this.db.getClusters()
  const [cluster] = clusters.filter((c: ClusterMetadata) => c.id === clusterId)
  if (!cluster) throw new Error('ClusterMetadata not found')

    const logFileName = `${Date.now()}-destroy-${Math.random().toString(36).slice(2)}-B2.log`
    const absoluteLogPath = path.join(LOG_DIR, logFileName)
    const activityArgs = { name: cluster.name, provider: cluster.provider, logFile: absoluteLogPath }
    const wfId = `cluster-destroy-${cluster.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    this.db.saveClusterInfo({
      id: cluster.id,
      name: cluster.name,
      provider: cluster.provider,
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
      promise: handle.result(),
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Deployment lifecycle
  // ────────────────────────────────────────────────────────────────────

  async deployApp(config: any): Promise<WorkflowDeal> {
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
        webRepo: config.webRepo,
        webTag: config.webTag,
        dbRepo: config.dbRepo,
        dbTag: config.dbTag,
        url: config.url,
      }
    }

  const clusters = await this.db.getClusters()
  const [targetCluster] = clusters.filter((c: ClusterMetadata) => c.id === dep.clusterId)
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
      strategy: dep.strategy || 'helm',
      appType: dep.appType || 'odoo',
      modules: dep.modules || [],
      odooRepo: (dep.webRepo as string) || '',
      odooTag: (dep.webTag as string) || '',
      dbRepo: (dep.dbRepo as string) || '',
      dbTag: (dep.dbTag as string) || '',
      logFile: absoluteLogPath,
      deploymentId,
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
      promise: handle.result(),
    }
  }

  async destroyApp(deploymentId: string): Promise<WorkflowDeal> {
    const deployments = await this.db.getDeployments()
    const [dep] = deployments.filter((d: DeploymentMetadata) => d.id === deploymentId)
    if (!dep) throw new Error('DeploymentMetadata not found (destroyApp)')

    const clusters = await this.db.getClusters()
    const [cluster] = clusters.filter((c: ClusterMetadata) => c.id === dep.clusterId)
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
      promise: handle.result(),
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Resize disk
  // ────────────────────────────────────────────────────────────────────

  async resizeDisk(deploymentId: string, storage: Record<string, string>): Promise<WorkflowDeal> {
    const deployments = await this.db.getDeployments()
    const [dep] = deployments.filter((d: DeploymentMetadata) => d.id === deploymentId)
    if (!dep) throw new Error('DeploymentMetadata not found (resizeDisk)')

    const clusters = await this.db.getClusters()
    const [cluster] = clusters.filter((c: ClusterMetadata) => c.id === dep.clusterId)
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
      promise: handle.result(),
    }
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
}
