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
import { sanitizeNamespace } from '../lib/model-registry.js'
import type { Database } from '../lib/db-interface.js'
import type { ClusterMetadata, ClusterProgress, DeploymentMetadata, ProjectMetadata, PipelineRunMetadata } from '../lib/types.js'
import { CapacityError, checkCapacity, requestedGpuCount } from '../lib/cluster-capacity.js'
import type { ClusterService } from './ClusterService.js'
import { ClusterProvisionWorkflow } from '../workflows/ClusterProvisionWorkflow.js'
import { LeafWorkflow } from '../workflows/LeafWorkflow.js'
import { executeDestroyClusterWorkflow } from '../workflows/DestroyClusterWorkflow.js'
import { executeDeployAppWorkflow } from '../workflows/AppDeployWorkflow.js'
import { executeDestroyAppWorkflow } from '../workflows/DestroyAppWorkflow.js'
import { executeResizeDiskWorkflow } from '../workflows/ResizeDiskWorkflow.js'
import { executeSyncConfigWorkflow } from '../workflows/SyncConfigWorkflow.js'
import { executePipelineRunWorkflow } from '../workflows/PipelineRunWorkflow.js'
import { resolveVllmDefaults, resolveTabbyDefaults, resolveCrawl4aiDefaults, resolveSearxngDefaults,
  resolveMinioDefaults, resolveQdrantDefaults, resolveQuickwitDefaults } from '../lib/app-env.js'
import { resolveAppSettingsDefaults } from '../lib/app-schemas.js'
import { resolveTabbyCacheHostPath } from '../lib/tabby-cache-path.js'
import type { Server as SocketServer } from 'socket.io'

const HOST_QUEUE = 'host-ops-queue'
const CLUSTER_QUEUE = 'cluster-ops-queue'
const WORKFLOW_POLL_INTERVAL = 5000
const RECONCILE_INTERVAL = 30000
/**
 * The dependency backstop runs far less often than the cluster/deployment reconciliation above.
 * It is not how work gets released any more — see the note at its call site — so a fast interval
 * would only mean scanning every leaf on the board twice a minute to find nothing.
 */
const DEPENDENCY_BACKSTOP_INTERVAL = 300000

/**
 * How often the memory bank is consolidated.
 *
 * Half an hour, not the reconcile loop's thirty seconds: nothing here is time-critical, every step
 * no-ops when there is nothing to do, and the pass reads the whole bank. It is the "dream" cadence —
 * tidying that happens between the work rather than during it.
 */
const CONSOLIDATE_INTERVAL = 1_800_000
const MAX_POLL_FAILURES = 12

/**
 * DeploymentMetadata fields holding a map that a PATCH may update partially. These get merged key
 * by key in updateConfigAndSync; every other field is overwritten wholesale. Add map-valued fields
 * here or a partial update will silently wipe the keys it didn't mention.
 */
const DEEP_MERGE_FIELDS = ['storage', 'appSettings'] as const

export interface WorkflowDeal {
  readonly id: string
  readonly resourceId?: string
  readonly event: string
}

// ────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────

async function getDefaultClient(address?: string): Promise<Client> {
  // Conditional spread, not `{ address }` — under exactOptionalPropertyTypes an explicit
  // `address: undefined` is not assignable to an optional `address?: string`.
  return getTemporalClient({ ...(address !== undefined ? { address } : {}) })
}

async function updateUserStatus(
  db: Database,
  clusterId: string,
  clusterName: string,
  // Optional: since this now spreads the existing record, the provider is already there. Callers
  // in trackWorkflow pass '' for deployment-scoped workflows (which have no provider at all), and
  // an empty string must not overwrite a real one.
  provider: ClusterMetadata['provider'] | '' | undefined,
  status: ClusterMetadata['status'],
  kubeconfigPath?: string,
): Promise<void> {
  const clusters = await db.getClusters();
  const existing = clusters.find((c: any) => c.id === clusterId);

  // 'destroyed' removes the record rather than persisting it, which makes this path agree with
  // ClusterService.delete() — that one filters the row out entirely. They disagreed, and the
  // disagreement was visible: k3d/mock rows got pruned later by reconcileAllClusters (no container
  // found), but 'remote' and 'hetzner' rows have no such check, so every destroyed VPS cluster
  // accumulated in the UI forever as a dead entry the user cannot act on.
  //
  // Deleting is also what makes the status honest. A row saying 'destroyed' is indistinguishable
  // from a row whose destroy FAILED and left something billing; a failed destroy stays 'failed' or
  // 'destroying' and remains visible, which is the case that actually needs attention.
  if (status === 'destroyed') {
    await db.saveClusterList(clusters.filter((c: any) => c.id !== clusterId));
    return;
  }
  // Spread `existing` first rather than naming individual carry-forward fields. db.saveCluster is
  // a full replaceOne, so anything omitted here is DELETED from the record — and this function
  // runs on every status transition. Listing fields by hand silently dropped the whole remote*
  // group (host/username/encrypted key), which meant a 'remote' cluster lost its SSH details the
  // moment it went healthy and could never be cleanly torn down again. For 'hetzner' the same
  // omission would orphan a running, billing VM with nothing left pointing at it.
  // `await` rather than `return` — saveClusterInfo resolves to the saved ClusterMetadata, and this
  // function's contract is Promise<void>.
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
  // Spread `deployment` rather than naming ~11 fields. db.saveDeployment is a full replaceOne, so
  // every field omitted here was being DELETED on each status transition — which meant the entire
  // vllm*/tabby*/webui* config group was wiped the moment a deployment went deploying → running.
  // The record then looked unconfigured, and the next config sync silently re-applied defaults
  // over whatever the user had actually chosen. Exact same hazard as updateUserStatus above.
  //
  // `existing` still wins for the bookkeeping fields it owns (workflow id, log path, owner), which
  // is what the previous field-by-field version was expressing.
  // `await`, not `return` — see updateUserStatus above.
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
  /** Structurally typed rather than importing HeadscaleService — only createPreAuthKey is used. */
  headscale?: { createPreAuthKey(userId: string, opts?: { reusable?: boolean; expirySeconds?: number }): Promise<{ key: string }> }

  /**
   * What the last consolidation pass did. Read by the Lab so the panel can say when the bank was
   * last tidied and what changed — a loop that edits memory unattended should be visible.
   */
  lastConsolidation?: ConsolidationReport

  constructor(
    db: Database,
    io?: SocketServer,
    masterKey?: string,
    clusterService?: ClusterService,
    // Optional: only used to mint mesh pre-auth keys during provisioning, and only when
    // MESH_LOGIN_SERVER is configured. Absent in tests and on a local dev box.
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
      await this.client.connection.close()
    } catch {
      // ignore
    }
  }

  /**
   * What a COMPLETED deploy/sync/resize workflow means for the deployment record.
   *
   * ── WHY THIS IS A FUNCTION AND NOT WRITTEN TWICE ──
   * Two places reconcile a finished app workflow: the per-workflow tracker, and the backstop loop
   * that catches one the tracker missed. Both decided the resulting status, and only the tracker
   * was taught about the rollout verdict — so the backstop kept hardcoding `running` and raced it.
   *
   * Confirmed live: a gitapp deploy whose container crashlooped ended up stored as `running` with
   * `healthReason: "CrashLoopBackOff"` still attached, because the two writers landed in that
   * order. The record contradicted itself, and only the pod-health pass eventually corrected it.
   *
   * A workflow with no verdict — an older run, or a result that cannot be read — reads as healthy,
   * which is the behaviour that predates the verdict entirely.
   */
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
      // Written on both branches, and empty on the healthy one. Absent would not do: writes merge
      // onto the stored record now, so leaving it out would keep a stale reason on a deployment
      // that a redeploy just fixed.
      meta: { ...meta, healthReason: unhealthy ? (verdict.workloadReason ?? '') : '' },
    }
  }

  trackWorkflow(
    wfId: string,
    action: 'cluster-provision' | 'cluster-destroy' | 'app-deploy' | 'app-destroy' | 'app-resize' | 'app-sync-config' | 'pipeline-run',
    resourceId: string,
    resourceName: string,
    // Typed rather than `string` because it is forwarded straight into updateUserStatus, which
    // writes it to ClusterMetadata.provider. App-side callers pass '' (there is no provider for a
    // deployment-scoped workflow), so the empty string is part of the contract.
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
              // A 'hetzner' cluster only learns its VM's identity here — the machine didn't exist
              // when the cluster row was written. Persisted before the status flips to 'healthy'
              // so a destroy triggered immediately afterwards can always find the VM; without
              // this the server would keep running (and billing) with nothing pointing at it.
              // Persisted for every provider that reports one, not just hetzner: a 'remote'
              // cluster joins the mesh too, and public ingress proxies to <meshIp>:<nodePort> for
              // the life of the cluster.
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
              // Measured node capacity (lib/cluster-capacity.ts). Re-reads `current` like the
              // blocks above because saveClusterInfo is a full replace — anything not carried
              // forward is silently dropped, including whatever the two saves above just wrote.
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
            }
            if (this.io) this.io.emit('deployment-updated')
          } else if (action === 'app-destroy') {
            if (name === 'FAILED') {
              await updateDeploymentStatus(this.db, resourceId, meta, 'failed', meta?.storage)
            } else if (name === 'TERMINATED' || name === 'CANCELLED' || name === 'COMPLETED') {
              // One row, deleted directly. Rewriting the whole collection to drop it is what
              // raced with concurrent writes and produced the E11000 on this exact path.
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


  /**
   * Starts the workflow backing a leaf.
   *
   * The workflow id is derived from the leaf id, so this is idempotent: calling it twice (a double
   * click, a retried request) addresses the same workflow rather than starting a second. Returns
   * undefined when Temporal is unreachable — the board must keep working without it, exactly as
   * cluster provisioning falls back to plain DB polling.
   */
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
      // WorkflowExecutionAlreadyStarted is the idempotent case, not a failure.
      if (/already started/i.test(err?.message ?? '')) return workflowId
      console.warn(`[TemporalBridge] Could not start leaf workflow ${workflowId}: ${err.message}`)
      return undefined
    }
  }

  /**
   * Signals a leaf's workflow. Best-effort by design: the database row is already updated by the
   * caller, so a missing or finished workflow must not fail the user's action — it only means the
   * leaf is no longer executing, which the board will show anyway.
   */
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

        /**
         * ── DOES THE WORKLOAD ACTUALLY RUN? ──
         *
         * Everything above reconciles a deployment against its WORKFLOW, and a workflow's verdict
         * is delivered once and never revisited. Even where the apply genuinely waited for the
         * rollout, that wait ended when the apply did — a workload killed an hour later by an OOM,
         * an evicted node, or a crash on first real traffic keeps its `running` record forever.
         * This is the only thing that watches a deployment for the rest of its life.
         *
         * Deliberately separate from the block below, and only for deployments that are NOT
         * mid-flight: a workflow that is still deploying owns that deployment's status, and a
         * second writer would race it.
         *
         * ── WHY THE KUBECONFIG IS RESOLVED ONCE PER CLUSTER ──
         * Resolving one is far from free. For the system cluster `getByIdUnscoped` shells out for
         * the kubeconfig, writes it to disk and reads live node capacity, and `getKubeconfigPath`
         * then repeats the fetch and the write. Done per deployment on a 30-second loop that is
         * several exec calls and file writes a minute, forever, to answer a question that has the
         * same answer for every deployment on the cluster. The cache lives for one cycle only —
         * long enough to deduplicate, short enough that a re-provisioned cluster is picked up on
         * the next pass.
         */
        const kubeconfigForCluster = new Map<string, string | undefined>()
        const resolveKubeconfig = async (clusterId: string): Promise<string | undefined> => {
          if (kubeconfigForCluster.has(clusterId)) return kubeconfigForCluster.get(clusterId)
          let path: string | undefined
          try {
            const cluster = await this.clusterService?.getByIdUnscoped(clusterId)
            if (cluster) path = await this.clusterService!.getKubeconfigPath(cluster)
          } catch {
            // Cached as undefined below: an unreachable cluster should not be retried once per
            // deployment within the same cycle.
          }
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

            /**
             * A pod that is up is not a service that answers.
             *
             * Both duplicate `github-mcp` deployments read `running`; one served three tools and the
             * other returned `HTTP 404 from initialize` to everything. Kubernetes was right about
             * both — the workload was placed — and the only signal on screen was true of both, which
             * is why nobody could tell them apart.
             *
             * Only for deployments that claim to speak MCP, and only when the workload itself looks
             * healthy: a crash-looping pod already has a better reason attached than "it did not
             * answer", and overwriting that would send someone to the wrong problem.
             *
             * Uses the registry's CACHE (no force): introspection holds for ten minutes, so this
             * costs one request per service per cache window, not one per thirty-second sweep.
             */
            let serviceReason = ''
            if (health === 'healthy' && looksLikeMcp(dep) && dep.ownerId) {
              try {
                const registry = new McpRegistryService(this.db, dep.ownerId, (n: string) => resolveMcpProbeUrl(n))
                const found = (await registry.listWithTools()).find((s) => s.id === dep.id)
                const verdict = healthFromProbe(found ? { unreachable: found.unreachable, tools: found.tools.length } : undefined)
                if (verdict) serviceReason = verdict.reason
              } catch {
                // A registry that cannot answer says nothing about the service. Leave it alone.
              }
            }

            const effective = serviceReason ? 'unhealthy' as const : health
            const next = reconciledStatus(dep.status, effective)
            if (next) {
              console.warn(`[Reconcile] ${dep.name} is ${dep.status} but the workload is ${effective}${(serviceReason || reason) ? ` (${serviceReason || reason})` : ''} — marking ${next}`)
              await updateDeploymentStatus(this.db, dep.id, { ...dep, healthReason: serviceReason || reason }, next, dep.storage)
              if (this.io) this.io.emit('deployment-updated')
            }
          } catch {
            // A cluster that is unreachable, or a namespace that is gone, says nothing about the
            // workload's health — and must never flip a deployment on its own.
          }
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
                // Same verdict the tracker applies. Hardcoding `running` here is what let this
                // backstop overwrite a correct `unhealthy` written moments earlier.
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
    /**
     * Start leaves whose turn has come.
     *
     * Its own try/catch, and deliberately AFTER the one above: that block covers clusters and
     * deployments under a single catch, so a transient Temporal error while polling one cluster
     * would otherwise skip the rest of the pass — and work waiting on a dependency would sit
     * there until something unrelated started succeeding again.
     *
     * ── A BACKSTOP NOW, NOT THE MECHANISM ──
     * Release is event-driven: a finishing leaf wakes its dependents with `signalWithStart` from
     * inside its own workflow (see activities/LeafGateActivity.ts). That is a Temporal activity,
     * so it is retried and cannot be lost the way an in-process event can — which was the whole
     * argument for polling in the first place, and it was wrong.
     *
     * This pass survives for the one case activities cannot cover: a workflow TERMINATED from
     * outside runs no more activities, so nothing wakes what it was blocking. Slow on purpose,
     * and loud when it fires — by the time it does, the primary path has already failed, and
     * that is worth seeing rather than quietly papering over.
     */
    try {
      const leaves = await this.db.getLeaves()
      for (const leaf of readyToStart(leaves)) {
        const workflowId = await this.startLeaf(leaf)
        if (!workflowId) continue
        // Written before the next iteration, so a crash mid-pass cannot start it twice: the
        // next pass reads a leaf that already has a workflow and skips it.
        await this.db.saveLeaf({ ...leaf, workflowId, updatedAt: new Date().toISOString() })
        // WARN, not log: the finishing dependency should have woken this leaf directly. Reaching
        // here means that never happened.
        console.warn(`[Reconcile] BACKSTOP started "${leaf.title}" — its dependencies completed but nothing woke it. A leaf workflow was probably terminated.`)
        if (this.io) this.io.emit('leaf-updated')
      }
    } catch (err: any) {
      console.warn(`[Reconcile] Could not release waiting leaves: ${err.message}`)
    }
  }

    /**
     * Pipeline runs, whose status is otherwise written only by whoever was watching.
     *
     * If nothing was watching — the backend restarted, the workflow was terminated by hand,
     * Temporal was briefly unreachable — the record keeps whatever it last said, forever. Measured:
     * five runs sat at `queued` for over three hours after their workflows were terminated, so the
     * queue read as permanently busy and nothing in the system disagreed.
     *
     * Clusters and deployments were already reconciled here. Runs were simply never added.
     */
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
            /**
             * A workflow Temporal has never heard of is an ANSWER — terminated and aged out, or
             * never started. Anything else is Temporal being unreachable, where saying nothing is
             * the only safe move: guessing would mark every live run failed during a brief outage.
             */
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

    /**
     * ── THE CONSOLIDATION PASS ──
     *
     * The review queue was the only thing bounding this bank's growth, and only by accident: 124 of
     * 143 memories sat in it unread. `memory-decide.ts` removed it deliberately, which means
     * something has to do the tidying it was accidentally doing. See lib/memory-consolidate.ts.
     *
     * Here rather than in a Temporal workflow because this file already owns every periodic job in
     * the platform and no Temporal Schedules exist to extend; in the backend process because that
     * one hot-reloads, and the workers do not.
     *
     * The in-flight guard is not decoration: the pass reads the whole bank and writes to Qdrant, and
     * two overlapping passes would each decide what to retire from a snapshot the other is editing.
     */
    let consolidating = false
    const consolidate = async () => {
      if (consolidating) return
      consolidating = true
      try {
        const memories = await this.db.getMemories().catch(() => [])
        const ownerId = memories[0]?.ownerId
        // Endpoints are per-owner, so a bank spanning several owners resolves the first one's and
        // consolidates the rest on titles alone. Correct, just less thorough — and the title rule
        // is the one that catches what this bank actually accumulates.
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

        // Logged only when it did something. A line every half hour saying nothing happened is a
        // line nobody reads, and then the one that matters is not read either.
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


    /**
     * ── LEAVES ──
     *
     * The only resource in this loop that had no reconciler, and the one that needed it most: a
     * leaf's OTHER backstop (`readyToStart`) requires `!workflowId`, and LeafWorkflow claims the id
     * immediately — so once a leaf has a workflow, that workflow is the only thing that can ever
     * move it. Measured: two leaves sat `pending` for four and a half days holding ids for
     * workflows Temporal no longer had, and because `requestFinished` is false while any leaf is
     * live, their branch could never land its work or run its acceptance either.
     *
     * The decision rules are pure and tested in lib/leaf-reconcile.ts.
     */
    const reconcileLeaves = async () => {
      if (!this.client) return
      try {
        const leaves = await this.db.getLeaves()
        for (const leaf of leaves) {
          if (!(LIVE_LEAF_STATUSES as readonly string[]).includes(leaf.status)) continue
          if (!leaf.workflowId) continue   // the readyToStart backstop already owns this case

          const attempts = (leaf.attempts ?? []).length
          let decision: LeafReconcileAction | undefined
          try {
            const described = await pollWorkflowRun(leaf.workflowId)
            decision = reconcileLeaf(leaf.status, described?.status?.name, attempts)
          } catch (err: any) {
            // A workflow Temporal has never heard of is an ANSWER. Anything else is Temporal being
            // unreachable, where saying nothing is the only safe move.
            if (!/not\s*found/i.test(String(err?.message ?? err))) continue
            decision = reconcileMissingLeafWorkflow(leaf.status, leaf.updatedAt, attempts)
          }
          if (!decision) continue

          /**
           * Re-read before writing. `saveLeaf` is a full replace with no merge, so writing the
           * object this pass read at the top would drop anything the leaf gained since.
           */
          const fresh = (await this.db.getLeaves()).find((l) => l.id === leaf.id)
          if (!fresh || fresh.status !== leaf.status) continue

          if (decision.action === 'restart') {
            // saveLeaf is a full replace, so OMITTING workflowId is what clears it — which is the
            // whole point: `readyToStart` requires `!workflowId` before it will start a leaf.
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

  /** Same chain as resolveHetznerToken, for DigitalOcean. */
  private async resolveDoToken(userId?: string): Promise<string | undefined> {
    let userCreds: any
    if (userId) {
      const user = await this.db.getUserById(userId)
      const enc = (user?.credentials as any)?.do?.token
      if (enc) {
        try {
          userCreds = { do: { token: decryptValue(enc, this.masterKey) } }
        } catch {
          // Corrupt blob or rotated masterKey — fall through to the env-var link in the chain.
        }
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
    const doToken = provider === 'do' ? await this.resolveDoToken(userId) : undefined
    if (provider === 'do' && !doToken) {
      throw new Error('No DigitalOcean API token configured — add one under Cloud Accounts first')
    }
    // Both providers create a machine we must be able to log into, so both need the keypair minted
    // once here rather than per attempt — see the comment below.
    const createsVm = provider === 'hetzner' || provider === 'do'

    // Generated HERE, once, and persisted below — not inside the activity. Hetzner bakes
    // authorized_keys into the machine as it boots, so a key minted per attempt means every retry
    // presents credentials the server has never seen; the VM stays up, keeps billing, and can
    // never be logged into again. Observed live: server created 21:45:22Z, the key it was
    // supposedly reachable with created 22:00:17Z, then Permission denied until the retry cap.
    const vmKeypair = createsVm
      ? await generateSshKeypair(`provisioning-${clusterName}`)
      : undefined

    // Mesh enrolment, minted under the OWNER's Headscale user so the node lands in that tenant's
    // namespace and the autogroup:self rule in headscale/config/acl.hujson isolates it from every
    // other tenant automatically.
    //
    // Best-effort and opt-in. MESH_LOGIN_SERVER is unset on a local dev box, where Headscale's
    // server_url is still localhost and no remote host could reach it; provisioning then keeps the
    // existing public-IP behaviour rather than failing. Reusable + 2h because provisioning takes
    // ~25 minutes and a retried activity must be able to present the same key again.
    const meshLoginServer = process.env.MESH_LOGIN_SERVER
    let meshPreAuthKey: string | undefined
    if (createsVm && meshLoginServer && this.headscale) {
      try {
        meshPreAuthKey = (await this.headscale.createPreAuthKey(userId, { reusable: true, expirySeconds: 2 * 60 * 60 })).key
      } catch (err: any) {
        // A mesh we cannot enrol into is a degraded cluster, not a failed provision — the VM still
        // comes up reachable on its public IP. Logged loudly because the resulting cluster will
        // then hit the 6443 firewall and look mysteriously unreachable.
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
      // the VM's actual identity (id, IP) only arrives when the workflow completes.
      ...(hetzner?.serverType ? { hetznerServerType: hetzner.serverType } : {}),
      ...(hetzner?.location ? { hetznerLocation: hetzner.location } : {}),
      ...(hetzner?.image ? { hetznerImage: hetzner.image } : {}),
      // Persisted BEFORE the workflow starts, not after it succeeds. This is the key that will be
      // baked into the VM, and it has to outlive any worker that dies mid-provision — otherwise a
      // restart mid-flight leaves a running server nobody holds the credentials for.
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

  // The workflow id carries Date.now() plus a random suffix, so Temporal's own deduplication can
  // never collapse two of these — a second click starts a genuinely separate destroy that races
  // the first over the same Terraform state and the same VM. Observed live: two concurrent
  // executeDestroyClusterWorkflow runs against one cluster.
  if (cluster.status === 'destroying') {
    throw new Error(`Cluster "${cluster.name}" is already being destroyed`)
  }

    const logFileName = `${Date.now()}-destroy-${Math.random().toString(36).slice(2)}-B2.log`
    const absoluteLogPath = path.join(LOG_DIR, logFileName)
    const doToken = cluster.provider === 'do' ? await this.resolveDoToken(cluster.ownerId) : undefined
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
      ...(doToken ? { doToken } : {}),
      ...(cluster.doServerId ? { doServerId: cluster.doServerId } : {}),
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
    const targetId = dep.appType === 'hermes' ? dep.hermesTargetId : (dep.appType === 'openwebui' ? dep.openWebuiTargetId : undefined);
    if (!targetId) return undefined;
    const target = allDeployments.find((d) => d.id === targetId);
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
    // Capacity preflight. This originally went into AppService.deploy, which is DEAD CODE — its
    // own comment says so, and nothing calls it, so the check never ran. Every real deploy comes
    // through here.
    //
    // Fails fast rather than letting the pod sit in Pending with "Insufficient memory" forever:
    // the cluster stays 'healthy' and the app never starts, which reads as a broken platform. A
    // cluster with no measured capacity skips the check entirely — never blocks.
    if (userId) {
      const cluster = (await this.db.getClusters()).find((c: ClusterMetadata) => c.id === config.clusterId)
      // Reads only the field belonging to the app type being deployed. It used to be
      // `config.vllmGpuCount ?? config.tabbyGpuCount ?? 0`, and since the wizard posts every app
      // type's fields on one object, that gave a WordPress deploy TabbyAPI's default of 2 GPUs and
      // refused it on a GPU-less cluster — see `requestedGpuCount`.
      const appType = config.appType || 'odoo'
      const problem = checkCapacity(appType, cluster?.capacity, requestedGpuCount(appType, config))
      if (problem) throw new CapacityError(problem)
    }

    // Find deployment row by name + clusterId (since config is req.body — may have no DB id)
    const unresolved = await this.db.getDeployments()
    let [dep] = unresolved.filter((d: DeploymentMetadata) => {
      if (config.name && d.name === config.name && d.clusterId === config.clusterId) return true
      if (config.id && d.id === config.id) return true
      return false
    })
    if (!dep) {
      dep = {
        // A brand-new record for a deployment the DB hasn't seen yet — it is about to be started.
        status: 'deploying',
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
        // Conditional spread — DeploymentMetadata.ownerId is optional, and under
        // exactOptionalPropertyTypes an explicit undefined is not the same as absent.
        ...(userId !== undefined ? { ownerId: userId } : {}),
      }
      dep = resolveVllmDefaults(dep as DeploymentMetadata)
      dep = resolveTabbyDefaults(dep as DeploymentMetadata)
      // Mint the web-tool credentials before persisting — see app-env.ts for why they cannot
      // be left to the constructs.
      dep = resolveCrawl4aiDefaults(dep as DeploymentMetadata)
      dep = resolveSearxngDefaults(dep as DeploymentMetadata)
      dep = resolveMinioDefaults(dep as DeploymentMetadata)
      dep = resolveQdrantDefaults(dep as DeploymentMetadata)
      // Reads the MinIO deployment beside it — see app-env.ts, Quickwit's storage keys are not
      // its own to generate.
      dep = resolveQuickwitDefaults(dep as DeploymentMetadata, await this.db.getDeployments())
      // Fills in the ~120 schema defaults the wizard didn't ask about, so the stored record and
      // the Config tab reflect what's actually running rather than 120 blanks.
      dep = resolveAppSettingsDefaults(dep as DeploymentMetadata)
    }

    /**
     * The link back to the project whose build produced this image.
     *
     * Applied here rather than in the record-construction block above, because that block only
     * runs for a BRAND-NEW deployment — a redeploy reuses the existing row and would drop the
     * link. Since the field has never been written before, every existing gitapp deployment has
     * none, and a redeploy is exactly the moment to backfill it.
     *
     * Without this the only thing connecting a deployment to its project is that
     * promoteProjectBuild passes the project's name through and deployApp finds-or-creates by
     * name — a join on a display name the user can change.
     */
    if (config.gitappProjectId) dep.gitappProjectId = config.gitappProjectId
    if (config.gitappImageTag) dep.gitappImageTag = config.gitappImageTag

    /**
     * The IMAGE, on an existing deployment.
     *
     * webRepo/webTag were set only in the `if (!dep)` branch above, so a deployment the database had
     * already seen kept its original image no matter what was deployed onto it. Promoting a new
     * build updated `gitappImageTag` — the record said the new tag — while the pod went on running
     * the old one.
     *
     * Measured: a build of the Streamable HTTP transport succeeded, promote ran, the record showed
     * `...:cb63805a`, and the deployment kept serving `...:cd7838d0`, which is the stdio-only image
     * that exits immediately. It looked like the transport had not been built.
     *
     * Taken from gitappImageTag when there is one, because that is the promote path and is
     * unambiguous. Otherwise from the config, ignoring the wizard's Odoo placeholders for non-Odoo
     * app types — the same rule DeployAppActivity applies, and without it a redeploy of any app
     * would clobber its image with `library/odoo`.
     */
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
    // Carried onto the RECORD, not only into the workflow arguments. Missing this is why the first
    // attempt deployed a container with no environment at all: the field travelled as far as the
    // deploy call and stopped, because everything downstream reads `dep`.
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
  /**
   * Derived, never minted — see lib/deployment-id.ts.
   *
   * Three deploys of this record started within 90ms, each read no id, and each invented one:
   * four Terraform stacks for one deployment, and every deploy afterwards failing to create a
   * namespace that already existed.
   */
  const deploymentId = deploymentIdFor(dep.deploymentId, dep.id || dep.name);
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
      // Cleared as the work restarts. Writes merge onto the stored record now, so a reason left
      // over from the last run would sit beside the new `deploying` and describe a pod that no
      // longer exists.
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
      // Cleared as the work restarts. Writes merge onto the stored record now, so a reason left
      // over from the last run would sit beside the new `deploying` and describe a pod that no
      // longer exists.
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
      // Cleared as the work restarts. Writes merge onto the stored record now, so a reason left
      // over from the last run would sit beside the new `deploying` and describe a pod that no
      // longer exists.
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

  // Merges an edited-config patch onto the EXISTING stored deployment (never a bare partial —
  // saveDeploymentInfo() reconstructs id/name/clusterId/strategy/status from defaults for
  // anything not present in what it's given, so passing just the changed fields would blank
  // out the rest of the row) and then re-applies it via syncConfig().
  async updateConfigAndSync(deploymentId: string, patch: Partial<DeploymentMetadata>): Promise<WorkflowDeal> {
    const deployments = await this.db.getDeployments()
    const dep = deployments.find((d: DeploymentMetadata) => d.id === deploymentId)
    if (!dep) throw new Error('DeploymentMetadata not found (updateConfigAndSync)')

    // Map-valued fields need a DEEP merge; everything else is a plain overwrite. Generalised over
    // a list rather than special-casing `storage` (as this did originally) because the next
    // map-valued field is exactly where the bug reappears: a Config-tab PATCH sends only the
    // settings the user actually changed, so a shallow spread would replace the whole map and
    // silently discard the other ~119 — then the CDKTF re-apply below would revert the server to
    // defaults.
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

  // ────────────────────────────────────────────────────────────────────
  // Temporal monitoring / query
  // ────────────────────────────────────────────────────────────────────

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
      // count() takes the query string directly, not a { query } options object — passing the
      // object silently produced a malformed request rather than a type error, since nothing ever
      // typechecked this file.
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
      // So the build Job is named per RUN — two runs of one commit used to collide.
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

  /**
   * Deploys (or redeploys) a project's built image — shared by the manual "promote" route and
   * the autoDeployOnBuild hook in trackWorkflow below. Reuses deployApp()'s own find-or-create
   * lookup (by name + clusterId) rather than distinguishing first-deploy vs redeploy itself —
   * calling this twice for the same project just redeploys the same DeploymentMetadata row.
   */
  /**
   * Starts a crawl and returns immediately.
   *
   * The agent gets a workflow id, not pages. Every byte goes from the crawler to the database
   * without passing through a context window — which is the whole reason this is a workflow rather
   * than a tool that fetches.
   */
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

  /** What an ingest has produced so far, or why it stopped. */
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
      // What makes "show me this project's deployment" answerable without matching on name.
      gitappProjectId: project.id,
      gitappImageTag: run.imageTag,
      // The project's own configuration. Without it a built image deploys and exits — measured on
      // the MCP server this platform built, which crash-looped on a missing GITHUB_TOKEN.
      ...(project.deployEnv ? { gitappEnv: project.deployEnv } : {}),
    }, userId);
  }
}
