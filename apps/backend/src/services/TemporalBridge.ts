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
import { Client } from '@temporalio/client'
import { getTemporalClient, pollWorkflowRun } from '../lib/temporal-client.js'
import { LocalDB } from '../lib/db.js'
import type { ClusterMetadata, DeploymentMetadata } from '../lib/types.js'
import { ClusterProvisionWorkflow } from '../workflows/ClusterProvisionWorkflow.js'
import { executeDestroyClusterWorkflow } from '../workflows/DestroyClusterWorkflow.js'
import { executeDeployAppWorkflow } from '../workflows/AppDeployWorkflow.js'
import { executeDestroyAppWorkflow } from '../workflows/DestroyAppWorkflow.js'
import { executeResizeDiskWorkflow } from '../workflows/ResizeDiskWorkflow.js'
import { Server as SocketServer } from 'socket.io'

const queue = 'provisioning-ops-queue'
const WORKFLOW_POLL_INTERVAL = 5000

export interface WorkflowDeal {
  readonly id: string
  readonly event: string
  promise: Promise<any>
}

// ────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────

async function getDefaultClient(address?: string): Promise<Client> {
  return getTemporalClient({ address })
}

function updateUserStatus(
  db: LocalDB,
  clusterId: string,
  clusterName: string,
  provider: string,
  status: string,
): Promise<void> {
  return db.saveClusterInfo({
    id: clusterId,
    name: clusterName,
    provider,
    status,
    temporalWorkflowId: undefined,
  })
}

function updateDeploymentStatus(
  db: LocalDB,
  deploymentId: string,
  deployment: DeploymentMetadata,
  status: string,
  storage = undefined,
): Promise<void> {
  return db.saveDeploymentInfo({
    id: deploymentId,
    name: deployment.name,
    clusterId: deployment.clusterId,
    strategy: deployment.strategy,
    appType: deployment.appType,
    status,
    modules: deployment.modules,
    storage,
    temporalWorkflowId: undefined,
    url: deployment.url,
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

  // ────────────────────────────────────────────────────────────────────
  // Cluster lifecycle
  // ────────────────────────────────────────────────────────────────────

  async provision(clusterName: string, provider: string): Promise<WorkflowDeal> {
    const wfId = `cluster-provision-${clusterName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const clusterLog = `${Date.now()}-${Math.random().toString(36).slice(2)}-A1.log`
    const activityArgs = { name: clusterName, provider, logFile: clusterLog }

    // Persist cluster row
    this.db.saveClusterInfo({
      name: clusterName,
      provider,
      status: 'provisioning',
      temporalWorkflowId: wfId,
    })

    const handle = await this.client.workflow.start(ClusterProvisionWorkflow, {
      workflowId: wfId,
      taskQueue: queue,
      args: [activityArgs],
    })

    // Start background poll — updates DB when workflow completes
    const timer = setInterval(async () => {
      const status = await pollWorkflowRun(wfId)
      if (status && status.status !== 'running') {
        clearInterval(timer)
        if (status.status === 'failed') {
          await updateUserStatus(this.db, '', clusterName + '-unknown', provider, 'failed')
        } else if (status.status === 'terminated' || status.status === 'cancelled') {
          await updateUserStatus(this.db, '', clusterName + '-unknown', provider, 'destroyed')
        } else {
          await updateUserStatus(this.db, '', clusterName + '-unknown', provider, 'healthy')
        }
      }
    }, WORKFLOW_POLL_INTERVAL)

    return {
      id: wfId,
      event: 'cluster-provision',
      promise: handle.result(),
    }
  }

async destroyCluster(clusterId: string): Promise<WorkflowDeal> {
  const clusters = await this.db.getClusters()
  const [cluster] = clusters.filter((c: ClusterMetadata) => c.id === clusterId)
  if (!cluster) throw new Error('ClusterMetadata not found')

    const wfId = `cluster-destroy-${cluster.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const clusterLog = `${Date.now()}-destroy-${Math.random().toString(36).slice(2)}-B2.log`
    const activityArgs = { name: cluster.name, provider: cluster.provider, logFile: clusterLog }

    this.db.saveClusterInfo({
      name: cluster.name,
      provider: cluster.provider,
      status: 'destroying',
      temporalWorkflowId: wfId,
    })

    const handle = await this.client.workflow.start(executeDestroyClusterWorkflow, {
      workflowId: wfId,
      taskQueue: queue,
      args: [activityArgs],
    })

    const timer = setInterval(async () => {
      const status = await pollWorkflowRun(wfId)
      if (status && status.status !== 'running') {
        clearInterval(timer)
        if (status.status === 'failed') {
          await updateUserStatus(this.db, '', cluster.name, cluster.provider, 'failed')
        } else if (status.status === 'terminated' || status.status === 'cancelled') {
          await updateUserStatus(this.db, '', cluster.name, cluster.provider, 'destroyed')
        } else {
          await updateUserStatus(this.db, '', cluster.name, cluster.provider, 'destroyed')
        }
      }
    }, WORKFLOW_POLL_INTERVAL)

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
    const [dep] = unresolved.filter((d: DeploymentMetadata) => {
      if (config.name && d.name === config.name && d.clusterId === config.clusterId) return true
      if (config.id && d.id === config.id) return true
      return false
    })
    if (!dep) throw new Error('DeploymentMetadata is not found (deployApp)')

  const clusters = await this.db.getClusters()
  const [targetCluster] = clusters.filter((c: ClusterMetadata) => c.id === dep.clusterId)
  const wfId = `app-deploy-${dep.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const taskLog = `${Date.now()}-${Math.random().toString(36).slice(2)}-C3.log`

    const activityArgs = {
      name: dep.name,
      clusterId: dep.clusterId,
      clusterName: cluster?.name || 'unknown',
      strategy: dep.strategy || 'helm',
      appType: dep.appType || 'odoo',
      modules: dep.modules || [],
      odooRepo: (dep.webRepo as string) || 'library/odoo',
      odooTag: (dep.webTag as string) || '18.0',
      dbRepo: (dep.dbRepo as string) || 'library/postgres',
      dbTag: (dep.dbTag as string) || 'latest',
      logFile: taskLog,
    }

    this.db.saveDeploymentInfo({
      ...dep,
      status: 'deploying',
      temporalWorkflowId: wfId,
    })

    const handle = await this.client.workflow.start(executeDeployAppWorkflow, {
      workflowId: wfId,
      taskQueue: queue,
      args: [activityArgs],
    })

    // Background polling: watch for workflow completion
    const timer = setInterval(async () => {
      const status = await pollWorkflowRun(wfId)
      if (status && status.status !== 'running') {
        clearInterval(timer)
        if (status.status === 'failed') {
          await updateDeploymentStatus(this.db, dep.id, dep, 'failed', dep.storage)
        } else if (status.status === 'terminated' || status.status === 'cancelled') {
          await updateDeploymentStatus(this.db, dep.id, dep, 'destroyed', dep.storage)
        } else if (status.status === 'completed') {
          await updateDeploymentStatus(this.db, dep.id, dep, 'running', dep.storage)
        }
      }
    }, WORKFLOW_POLL_INTERVAL)

    return {
      id: wfId,
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
    const taskLog = `${Date.now()}-${Math.random().toString(36).slice(2)}-D4.log`

    const activityArgs = {
      name: dep.name,
      clusterId: dep.clusterId,
      clusterName: cluster?.name || 'unknown',
      provider: cluster?.provider || 'k3d',
      strategy: dep.strategy || 'helm',
      logFile: taskLog,
    }

    this.db.saveDeploymentInfo({
      ...dep,
      status: 'destroying',
      temporalWorkflowId: wfId,
    })

    const handle = await this.client.workflow.start(executeDestroyAppWorkflow, {
      workflowId: wfId,
      taskQueue: queue,
      args: [activityArgs],
    })

    const timer = setInterval(async () => {
      const status = await pollWorkflowRun(wfId)
      if (status && status.status !== 'running') {
        clearInterval(timer)
        if (status.status === 'failed') {
          await updateDeploymentStatus(this.db, dep.id, dep, 'failed', dep.storage)
        } else if (status.status === 'terminated' || status.status === 'cancelled' || status.status === 'completed') {
          // delete the deployment row
          const deployments = await this.db.getDeployments()
          const arr = deployments.filter((d: any) => d.id !== deploymentId)
          await this.db.saveDeploymentList(arr)
        }
      }
    }, WORKFLOW_POLL_INTERVAL)

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
    const taskLog = `${Date.now()}-${Math.random().toString(36).slice(2)}-E5.log`

    const activityArgs = {
      name: dep.name,
      clusterId: dep.clusterId,
      clusterName: cluster?.name || 'unknown',
      provider: cluster?.provider || 'k3d',
      strategy: dep.strategy || 'helm',
      appType: dep.appType || 'odoo',
      storage,
      logFile: taskLog,
    }

    this.db.saveDeploymentInfo({
      ...dep,
      storage: { ...dep.storage, ...storage },
      status: 'deploying',
      temporalWorkflowId: wfId,
    })

    const handle = await this.client.workflow.start(executeResizeDiskWorkflow, {
      workflowId: wfId,
      taskQueue: queue,
      args: [activityArgs],
    })

    const timer = setInterval(async () => {
      const status = await pollWorkflowRun(wfId)
      if (status && status.status !== 'running') {
        clearInterval(timer)
        if (status.status === 'failed') {
          // delete deployment row
          const deployments = await this.db.getDeployments()
          const arr = deployments.filter((d: any) => d.id !== deploymentId)
          await this.db.saveDeploymentList(arr)
        } else if (status.status === 'terminated' || status.status === 'cancelled' || status.status === 'completed') {
          // delete deployment row
          const deployments = await this.db.getDeployments()
          const arr = deployments.filter((d: any) => d.id !== deploymentId)
          await this.db.saveDeploymentList(arr)
        }
      }
    }, WORKFLOW_POLL_INTERVAL)

    return {
      id: wfId,
      event: 'disk-resize',
      promise: handle.result(),
    }
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
