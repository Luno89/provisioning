import { until } from '../../platform/testing/three-roles.js';
import { resolve } from 'node:path';
import axios from 'axios';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { WORKER_DEFAULTS, activityInterceptors } from '@koala/engine-core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { infrastructureRouter } from './infrastructure.js';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import type { Database } from '../../platform/lib/db-interface.js';
import type { ClusterMetadata, DeploymentMetadata } from '../../platform/lib/types.js';
import { ownedQuery, startedFor } from '../../platform/lib/workflow-owner.js';

import { bundled, temporalTestEnvironment } from '../../workflows/temporal-test-env.js';
import { InfrastructureViewService } from '../services/InfrastructureViewService.js';
import { ClusterContentsService } from '../services/ClusterContentsService.js';
import { RunningService } from '../services/RunningService.js';
import { WorkFailureService } from '../services/WorkFailureService.js';
import type { BrokenWorkload } from '../services/ClusterContentsService.js';
import type { RunningRecords, RunningWorkflow } from '../lib/running.js';
import type { WorkFailure } from '../lib/work-failures.js';
import { MonitoringService } from '../../monitoring/services/MonitoringService.js';
import { prometheusStandIn, type PrometheusStandIn } from '../../monitoring/testing/prometheus-stand-in.js';
import { appQuery, appWindowQuery, koalaQuery, koalaServicesQuery } from '../../monitoring/lib/monitoring-questions.js';
import { OWN_SERIES } from '../../monitoring/lib/cluster-scope.js';
import { BenchService } from '../../checks/services/BenchService.js';
import { MemoryKeeperService } from '../../memory/services/MemoryKeeperService.js';
import { RootPresence } from '../../instances/services/RootPresence.js';
import { DependencyStates } from '../../platform/services/DependencyStates.js';
import type { DependencyDown } from '../../platform/lib/dependencies.js';
import { labelValue } from '../../engine-host/sandboxes/workspace.js';
import { runWaitingVia } from '../../engine-host/temporal/run-cancellation.js';
import { workflowOfRun } from '../../engine-host/temporal/contracts.js';
import { portToHandOn } from '@koala/engine-core/testing/ports';

const koalas = { id: 'machine-koala', name: 'koala', provider: 'machine', machineId: 'koala', status: 'healthy', ownerId: TEST_USER.id } as ClusterMetadata;
const shop = { id: 'd1', name: 'Shop', namespace: 'shop', clusterId: koalas.id, strategy: 'native', appType: 'audiobookshelf', ownerId: TEST_USER.id, status: 'running', createdAt: 'then' } as DeploymentMetadata;

const crashing = (namespace: string, name: string) => ({
  metadata: { name: `${name}-5d9c7b-abcde`, namespace, creationTimestamp: '2026-10-17T10:00:00Z', labels: { 'pod-template-hash': '5d9c7b' }, ownerReferences: [{ kind: 'ReplicaSet', name: `${name}-5d9c7b`, controller: true }] },
  status: { phase: 'Running', containerStatuses: [{ name: 'main', ready: false, restartCount: 4, state: { waiting: { reason: 'CrashLoopBackOff' } } }] },
});

const onCluster = {
  pods: { items: [crashing('shop', 'shop-web'), crashing('mystery', 'mystery')] },
  namespaces: { items: [{ metadata: { name: 'shop' } }, { metadata: { name: 'mystery', labels: { 'koala.dev/owner': labelValue(TEST_USER.id) } } }] },
};

const reportingKoala = (prom: PrometheusStandIn) => {
  prom.answers.set(prom.scoped(koalaServicesQuery()), [{ metric: { service_name: 'koala-worker-engine' }, value: 1 }, { metric: { service_name: 'koala-backend' }, value: 1 }]);
  prom.set(koalaQuery('requestsPerSecond'), 2.5).set(koalaQuery('modelCallsPerMinute'), 1).set(koalaQuery('reporting'), 2);
};

const shopIsDown = (prom: PrometheusStandIn) => {
  const subject = { namespace: 'shop', services: ['web'] };
  prom.set('kube_service_info{namespace="shop"}', 1, { service: 'web' });
  prom.set(appQuery('probed', subject), 1).set(appQuery('up', subject), 0).set(appQuery('podsRunning', subject), 1)
    .set(appWindowQuery('uptime', subject, 86_400), 1).set(appWindowQuery('restarts', subject, 86_400), 0);
};

let env: TestWorkflowEnvironment;
let worker: Worker;
let working: Promise<void>;
let prom: PrometheusStandIn;
const taskQueue = `infrastructure-${Math.random().toString(36).slice(2, 8)}`;

const listed = async (ownerId: string): Promise<RunningWorkflow[]> => {
  const found: RunningWorkflow[] = [];
  for await (const workflow of env.client.workflow.list({ query: `${ownedQuery(ownerId)} AND ExecutionStatus = "Running"` })) {
    found.push({ workflowId: workflow.workflowId, type: workflow.type, startedAt: workflow.startTime.toISOString(), ...(workflow.memo ? { memo: workflow.memo } : {}) });
  }
  return found;
};

beforeAll(async () => {
  env = await temporalTestEnvironment();
  worker = await Worker.create({ ...WORKER_DEFAULTS, interceptors: { activity: activityInterceptors() }, connection: env.nativeConnection, namespace: env.namespace ?? 'default', taskQueue, workflowBundle: await bundled(resolve(__dirname, '../testing/waiting-run.fixture-workflow.ts')) });
  working = worker.run();
  prom = await prometheusStandIn(OWN_SERIES);
  const start = (workflowId: string, waitsFor: string[], memo: Record<string, unknown>) =>
    env.client.workflow.start('AgentRunWorkflow', { taskQueue, workflowId, args: [waitsFor], memo, ...startedFor(TEST_USER.id) });
  await start('release-p1', ['decide'], { runId: 'release-p1~1' });
  await start('run-r2', [], { runId: 'run-r2', agent: 'koala', conversation: 'c2' });
  const ended = await start('r1', [], { runId: 'r1', agent: 'koala', conversation: 'c1' });
  await ended.signal('cancelRun');
  await ended.result();
  await until(async () => ((await listed(TEST_USER.id)).length === 2 ? true : undefined));
}, 120_000);

afterAll(async () => {
  worker?.shutdown();
  await working;
  await prom?.close();
  await env?.teardown();
});

let harness: Harness;
let presence: RootPresence | undefined;
afterEach(async () => {
  presence?.stop();
  presence = undefined;
  await harness.close();
  vi.restoreAllMocks();
});

const recordsOf = (db: Database) => async (ownerId: string): Promise<RunningRecords> => {
  const [trees, projects, conversations, checkRuns, releases] = await Promise.all([
    db.projects.getTrees(), db.projects.getProjects(), db.engine.getConversations(), db.checks.getEvalRecords('evalScenarioRuns', ownerId, 100), db.releases.getOdooReleases(ownerId),
  ]);
  return {
    trees: trees.filter((entry) => entry.ownerId === ownerId),
    projects: projects.filter((entry) => entry.ownerId === ownerId),
    conversations: conversations.filter((entry) => entry.ownerId === ownerId),
    checkRuns: checkRuns.map((run) => ({ id: run.id })),
    releases,
    agentName: (slug) => (slug === 'koala' ? 'Koala' : undefined),
  };
};

async function app(root?: { rootPort: number }) {
  let failures: WorkFailureService | undefined;
  harness = await mountRouter({
    prefix: '/api/infrastructure',
    ...(root ? { claims: { role: 'instance' as const, instanceOwnerId: TEST_USER.id } } : {}),
    router: async (db) => {
      await db.accounts.saveUser({ id: TEST_USER.id, email: TEST_USER.email, twoFactorEnabled: false, emailVerified: true, createdAt: 'then' } as never);
      await db.infrastructure.saveDeploymentInfo(shop);
      await db.projects.saveProject({ id: 'p1', name: 'Books', ownerId: TEST_USER.id, appType: 'odoo-project', createdAt: 'then' } as never);
      await db.releases.saveOdooRelease({ id: 'rel-1', ownerId: TEST_USER.id, projectId: 'p1', pipelineRunId: 'b1', commit: 'abc12345def', image: 'reg/books:abc', state: 'preview', host: 'books.koala.test' } as never);
      await db.engine.saveConversation({ id: 'c1', ownerId: TEST_USER.id, title: 'Labels', messages: [], createdAt: 'then', updatedAt: 'then' } as never);
      await db.engine.saveConversation({ id: 'c2', ownerId: TEST_USER.id, title: 'Shelves', messages: [], createdAt: 'then', updatedAt: 'then' } as never);
      prom.answers.clear();
      prom.set('vector(1)', 1);
      reportingKoala(prom);
      shopIsDown(prom);
      const monitoring = new MonitoringService({
        store: db,
        ownCluster: async () => koalas,
        ownClusterId: () => koalas.id,
        prometheus: async () => prom.client,
        kubectl: async (_cluster, args) => (args[0] === 'get' && args[1] === 'service' ? `service/${args[2]}` : ''),
        apply: async () => undefined,
        helm: async () => JSON.stringify([{ name: 'kube-prometheus-stack', namespace: 'monitoring', chart: 'kube-prometheus-stack-79.1.0' }]),
        now: () => new Date('2026-10-17T12:00:00Z'),
      });
      const contents = new ClusterContentsService({
        monitoring,
        deployments: () => db.infrastructure.getDeployments(),
        kubectl: async (_cluster, args) => JSON.stringify(args[1] === 'pods' ? onCluster.pods : args[1] === 'namespaces' ? onCluster.namespaces : { items: [] }),
        helm: async () => '[]',
        labelOf: labelValue,
        now: () => new Date('2026-10-17T12:00:00Z'),
      });
      const records = recordsOf(db);
      const bench = new BenchService({
        store: db,
        scenarios: async () => [],
        fingerprints: async () => ({}),
        start: async () => undefined,
        serving: async () => undefined,
        changes: { pending: async () => [], comparing: async () => undefined, settle: async () => undefined },
        earlier: async () => [],
        notifyChange: () => undefined,
        practices: { trials: async () => [], settle: async () => undefined },
        benchRunning: async () => false,
        agentsRunning: async () => false,
        idleTimer: async () => undefined,
        notify: () => undefined,
      });
      const keeper = new MemoryKeeperService({ store: db, start: vi.fn(), timer: vi.fn() as never, concludeAfterMinutes: async () => undefined });
      const running = new RunningService({
        workflows: {
          list: listed,
          waiting: runWaitingVia(async () => env.client),
          cancel: async () => 'unreachable',
        },
        records,
        checks: { cancel: async () => false },
        trees: { stop: async () => ({ ok: false, error: 'no trees here' }) },
        runs: { cancel: async () => undefined },
        bench,
        keeper,
      });
      failures = new WorkFailureService({
        store: db.infrastructure,
        workflows: {
          describeRun: async (runId) => {
            const described = await env.client.workflow.getHandle(workflowOfRun(runId)).describe();
            return { workflowId: described.workflowId, type: described.type, startedAt: described.startTime.toISOString(), ...(described.memo ? { memo: described.memo } : {}) };
          },
        },
        records,
        accounts: db.accounts,
        now: () => new Date('2026-10-17T11:00:00Z'),
      });
      await failures.runEnded({ ownerId: TEST_USER.id, runId: 'r1', outcome: 'failed', reason: 'the model refused', depth: 0 });
      const dependencies = root ? new DependencyStates({ process: 'backend', described: ['root'], where: { root: `http://127.0.0.1:${root.rootPort}` } }) : undefined;
      if (root) {
        presence = new RootPresence({
          rootUrl: `http://127.0.0.1:${root.rootPort}`,
          instanceId: 'i1',
          ownerId: TEST_USER.id,
          token: async () => 'a-token',
          tell: async () => undefined,
          afterMs: 0,
          now: () => new Date('2026-10-29T10:00:00.000Z'),
          dependency: dependencies,
        });
        presence.start();
        await db.platform.saveDependencyState({ process: 'worker-engine', dependency: 'gitea', state: 'down', since: '2026-10-29T10:05:00.000Z', reason: 'it refused the connection (ECONNREFUSED)', at: '2026-10-29T10:05:00.000Z' });
        await db.platform.saveDependencyState({ process: 'worker-cluster', dependency: 'gitea', state: 'answering', at: '2026-10-29T10:05:00.000Z' });
      }
      const infrastructure = new InfrastructureViewService({
        monitoring, contents, running, failures,
        ...(dependencies ? { dependencies: { own: () => dependencies.down(), workers: () => db.platform.dependencyStates() } } : {}),
      });
      return infrastructureRouter({ infrastructure });
    },
  });
  return { failures: failures!, db: harness.db };
}

interface InfrastructureAnswer {
  workloads: BrokenWorkload[];
  waiting: { workflowId: string }[];
  running: number;
  failures: unknown;
  monitoring: { attention: unknown[] };
  koala: unknown;
  dependencies: DependencyDown[];
}

const failure: WorkFailure = { id: 'run:r1', ownerId: TEST_USER.id, workflowId: 'r1', kind: 'chat', title: 'Koala answering in "Labels"', opens: { kind: 'chat', id: 'c1' }, reason: 'the model refused', failedAt: '2026-10-17T11:00:00.000Z' };

describe('/api/infrastructure', () => {
  it('puts together what needs the person: health, broken workloads not already told by their app, work waiting on them, failures', async () => {
    await app();
    const res = await axios.get<InfrastructureAnswer>(harness.url('/api/infrastructure'));
    expect(res.data.workloads.map((workload) => workload.name)).toEqual(['mystery']);
    expect(res.data.waiting.map((item) => item.workflowId)).toEqual(['release-p1']);
    expect(res.data.running).toBe(2);
    expect(res.data.failures).toEqual([failure]);
    expect(res.data.monitoring.attention).toHaveLength(1);
    expect(res.data.koala).toEqual({
      state: 'ok', reasons: [], numbers: { requestsPerSecond: 2.5, modelCallsPerMinute: 1, reporting: 2 }, services: ['koala-backend', 'koala-worker-engine'],
      lines: ['Koala is healthy.', '2 processes report: koala-backend, koala-worker-engine.', 'It serves 2.5 requests a second.', 'Models: 1.0 calls a minute.'], telemetry: { collector: true, tempo: true }, checkedAt: '2026-10-17T12:00:00.000Z',
    });
  });

  it('says when the instance cannot reach root, and which dependency a worker recorded down, and says nothing where it is not an instance', async () => {
    const rootPort = await portToHandOn();
    await app({ rootPort });
    const dependencies = await until(async () => {
      const said = (await axios.get<InfrastructureAnswer>(harness.url('/api/infrastructure'))).data.dependencies;
      return said.some((down) => down.dependency === 'root') ? said : undefined;
    });
    expect(dependencies).toEqual([
      { dependency: 'root', name: 'Koala\'s root', since: '2026-10-29T10:00:00.000Z', reason: 'this instance\'s connection to it is closed', process: 'backend', where: `http://127.0.0.1:${rootPort}` },
      { dependency: 'gitea', name: 'Gitea', since: '2026-10-29T10:05:00.000Z', reason: 'it refused the connection (ECONNREFUSED)', process: 'worker-engine' },
    ]);
    presence?.stop();
    presence = undefined;
    await harness.close();
    await app();
    expect((await axios.get<InfrastructureAnswer>(harness.url('/api/infrastructure'))).data.dependencies).toEqual([]);
  });

  it('reads one cluster', async () => {
    await app();
    const res = await axios.get(harness.url(`/api/infrastructure/clusters/${koalas.id}`));
    expect(res.data).toMatchObject({ clusterId: koalas.id, reachable: true });
  });

  it('clears the failures named, or all of them, and refuses anything else', async () => {
    const { failures, db } = await app();
    for (const runId of ['r1a', 'r1b', 'r1c']) {
      await db.infrastructure.addWorkFailure({ ...failure, id: `run:${runId}`, workflowId: runId });
    }
    const clearing = vi.spyOn(failures, 'clear');
    const clear = (body: unknown) => axios.post(harness.url('/api/infrastructure/failures/clear'), body);
    expect((await clear({ ids: ['run:r1'] })).data).toEqual({ cleared: 1 });
    expect((await clear({})).data).toEqual({ cleared: 3 });
    await expect(clear({ ids: 'run:r1' })).rejects.toMatchObject({ response: { status: 400 } });
    expect(clearing.mock.calls.map(([, ids]) => ids)).toEqual([['run:r1'], 'all']);
  });
});
