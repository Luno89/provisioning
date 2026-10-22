import {
  type Database, servesTenants, type RoleConfig, ownedQuery, ownerIn, getTemporalClient, type MetricsService,
} from '../../platform/index.js';
import { DEFAULT_BENCH_SETTINGS } from '../../checks/lib/bench.js';
import type { RunningRecords, RunningWorkflow } from '../lib/running.js';
import { WorkFailureService, type ClosedWorkflow } from '../services/WorkFailureService.js';
import { RunningService } from '../services/RunningService.js';
import { ClusterContentsService } from '../services/ClusterContentsService.js';
import { InfrastructureViewService } from '../services/InfrastructureViewService.js';
import type { TemporalBridge } from '../services/TemporalBridge.js';
import type { MonitoringService } from '../../monitoring/index.js';
import type { Level2Service } from '../../checks/services/Level2Service.js';
import type { GroveRunService } from '../../projects/index.js';
import type { BenchService } from '../../checks/services/BenchService.js';
import type { MemoryKeeperService } from '../../memory/services/MemoryKeeperService.js';
import type { InfrastructureService } from '../services/InfrastructureService.js';
import type { ClusterService } from '../services/ClusterService.js';
import type { createRunStarter } from '../../engine-host/index.js';
import { labelValue } from '../../engine-host/sandboxes/workspace.js';
import { runWaitingVia } from '../../engine-host/temporal/run-cancellation.js';
import { workflowOfRun } from '../../engine-host/temporal/contracts.js';
import { runningRouter } from '../routes/running.js';
import { infrastructureRouter } from '../routes/infrastructure.js';
import type { Mounts } from '../../hub/index.js';

export interface WorkFailuresDeps {
  db: Database;
  temporalBridge: TemporalBridge;
  metrics: Pick<MetricsService, 'failed'>;
  records: (ownerId: string) => Promise<RunningRecords>;
}

export function workFailuresFor(deps: WorkFailuresDeps): WorkFailureService {
  const { db, temporalBridge } = deps;
  const runningRecords = deps.records;
  const workFailures = new WorkFailureService({
    store: db.infrastructure,
    onFailure: (failure) => deps.metrics.failed(failure.kind),
    workflows: {
      closedSince: async (since) => {
        if (!temporalBridge.isReady()) return [];
        const found: ClosedWorkflow[] = [];
        const query = `(ExecutionStatus = "Failed" OR ExecutionStatus = "TimedOut") AND CloseTime > "${since.toISOString()}"`;
        for await (const workflow of temporalBridge.client.workflow.list({ query })) {
          found.push({
            workflowId: workflow.workflowId,
            temporalRunId: workflow.runId,
            type: workflow.type,
            startedAt: workflow.startTime.toISOString(),
            closedAt: (workflow.closeTime ?? new Date()).toISOString(),
            status: workflow.status.name === 'TIMED_OUT' ? 'TIMED_OUT' : 'FAILED',
            ownerId: ownerIn(workflow.typedSearchAttributes),
            ...(workflow.parentExecution?.workflowId ? { parent: workflow.parentExecution.workflowId } : {}),
            ...(workflow.memo ? { memo: workflow.memo } : {}),
          });
        }
        return found;
      },
      failureOf: async (workflowId, temporalRunId) => {
        try {
          await temporalBridge.client.workflow.getHandle(workflowId, temporalRunId).result();
          return undefined;
        } catch (err) {
          return { message: (err as Error).message, cause: { message: (err as { cause?: Error }).cause?.message } };
        }
      },
      describeRun: async (runId) => {
        if (!temporalBridge.isReady()) return undefined;
        const described = await temporalBridge.client.workflow.getHandle(workflowOfRun(runId)).describe();
        return { workflowId: described.workflowId, type: described.type, startedAt: described.startTime.toISOString(), ...(described.memo ? { memo: described.memo } : {}) };
      },
    },
    records: runningRecords,
    isPerson: async (ownerId) => {
      const user = await db.accounts.getUserById(ownerId);
      return Boolean(user) && !user!.space && !user!.removal;
    },
    log: (message) => console.warn(message),
  });

  return workFailures;
}

export interface RunningWiringDeps {
  tenant: Mounts;
  db: Database;
  role: RoleConfig;
  temporalBridge: TemporalBridge;
  monitoring: MonitoringService;
  workFailures: WorkFailureService;
  records: (ownerId: string) => Promise<RunningRecords>;
  checks: Pick<Level2Service, 'cancel'>;
  trees: Pick<GroveRunService, 'stop'>;
  runs: Pick<ReturnType<typeof createRunStarter>, 'cancel'>;
  bench: { service?: BenchService };
  keeper: MemoryKeeperService;
  infra: InfrastructureService;
  clusters: ClusterService;
}

export function wireRunning(deps: RunningWiringDeps): { running: RunningService } {
  const { tenant, db, role, temporalBridge, monitoring, workFailures } = deps;
  const waitingOf = runWaitingVia(() => getTemporalClient());
  const running = new RunningService({
    workflows: {
      list: async (ownerId) => {
        if (!temporalBridge.isReady()) return undefined;
        const found: RunningWorkflow[] = [];
        for await (const workflow of temporalBridge.client.workflow.list({ query: `${ownedQuery(ownerId)} AND ExecutionStatus = "Running"` })) {
          found.push({
            workflowId: workflow.workflowId,
            type: workflow.type,
            startedAt: workflow.startTime.toISOString(),
            ...(workflow.parentExecution?.workflowId ? { parent: workflow.parentExecution.workflowId } : {}),
            ...(workflow.memo ? { memo: workflow.memo } : {}),
          });
        }
        return found;
      },
      waiting: (workflowId) => waitingOf(workflowId),
      cancel: (workflowId) => temporalBridge.cancelWorkflow(workflowId),
    },
    records: deps.records,
    checks: { cancel: (ownerId, id) => deps.checks.cancel(ownerId, id) },
    trees: { stop: async (ownerId, treeId) => { const outcome = await deps.trees.stop(ownerId, treeId); return outcome.ok ? { ok: true } : { ok: false, error: outcome.error }; } },
    runs: { cancel: (runId) => deps.runs.cancel(runId) },
    bench: {
      settings: async (ownerId) => (deps.bench.service ? deps.bench.service.settings(ownerId) : { ...DEFAULT_BENCH_SETTINGS }),
      saveSettings: async (ownerId, value) => (deps.bench.service ? deps.bench.service.saveSettings(ownerId, value) : { saved: false, problems: ['the bench is not set up here'] }),
    },
    keeper: deps.keeper,
  });
  tenant.use('/api/running', runningRouter({ running }));
  const clusterContents = new ClusterContentsService({
    monitoring,
    deployments: () => db.infrastructure.getDeployments(),
    kubectl: async (cluster, args) => String(await deps.infra.runKubectl(args, await deps.clusters.getKubeconfigPath(cluster))),
    helm: async (cluster, args) => String(await deps.infra.runHelm(args, await deps.clusters.getKubeconfigPath(cluster))),
    labelOf: labelValue,
  });
  tenant.use('/api/infrastructure', infrastructureRouter({
    infrastructure: new InfrastructureViewService({ monitoring, contents: clusterContents, running, failures: workFailures }),
  }));
  if (servesTenants(role)) workFailures.start();
  return { running };
}
