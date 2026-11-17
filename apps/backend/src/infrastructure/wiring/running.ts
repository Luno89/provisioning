import {
  type Database, type RoleConfig, ownedQuery, getTemporalClient, type MetricsService,
} from '../../platform/index.js';
import { DEFAULT_BENCH_SETTINGS, type Level2Service, type BenchService } from '../../checks/index.js';
import type { RunningRecords, RunningWorkflow } from '../lib/running.js';
import { WorkFailureService } from '../services/WorkFailureService.js';
import { RunningService } from '../services/RunningService.js';
import { ClusterContentsService, type KoalaPlace } from '../services/ClusterContentsService.js';
import { InfrastructureViewService, type InfrastructureViewDeps } from '../services/InfrastructureViewService.js';
import type { TemporalBridge } from '../services/TemporalBridge.js';
import type { MonitoringService } from '../../monitoring/index.js';
import type { GroveRunService } from '../../projects/index.js';
import type { MemoryKeeperService } from '../../memory/index.js';
import { runnersByRecord, type ClusterAccess } from '../services/ClusterAccess.js';
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
      describeRun: async (runId) => {
        if (!temporalBridge.isReady()) return undefined;
        const described = await temporalBridge.client.workflow.getHandle(workflowOfRun(runId)).describe();
        return { workflowId: described.workflowId, type: described.type, startedAt: described.startTime.toISOString(), ...(described.memo ? { memo: described.memo } : {}) };
      },
    },
    records: runningRecords,
    accounts: db.accounts,
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
  access: Pick<ClusterAccess, 'kubectl' | 'helm' | 'apply'>;
  koala?: KoalaPlace | undefined;
  dependencies?: InfrastructureViewDeps['dependencies'];
  signals?: InfrastructureViewDeps['signals'];
  egress?: InfrastructureViewDeps['egress'];
}

export function wireRunning(deps: RunningWiringDeps): { running: RunningService } {
  const { tenant, db, temporalBridge, monitoring, workFailures } = deps;
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
    runs: { cancel: (runId, by) => deps.runs.cancel(runId, by) },
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
    ...runnersByRecord(deps.access),
    labelOf: labelValue,
    koala: deps.koala,
  });
  tenant.use('/api/infrastructure', infrastructureRouter({
    infrastructure: new InfrastructureViewService({ monitoring, contents: clusterContents, running, failures: workFailures, dependencies: deps.dependencies, signals: deps.signals, egress: deps.egress }),
  }));
  return { running };
}
