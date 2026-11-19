import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { WORKER_DEFAULTS, activityInterceptors } from '@koala/engine-core';
import { reopening } from '@koala/engine-core/reopening';
import type { ModelProvider } from '@koala/agent-engine';
import { nodeProcesses, nodeStreams } from '../../platform/index.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { testDataDir } from '../../platform/testing/data-dir.js';
import { bundled, realTemporalEnvironment } from '../../workflows/testing/temporal-test-env.js';
import { DEFAULT_STREAM_TASK_QUEUE } from '../../engine-host/temporal/contracts.js';
import { createEngineActivities, createNodeRunner } from '../../engine-host/temporal/activities.js';
import { createHostOpNodes } from '../../engine-host/nodes/host-op-nodes.js';
import { createAgentRegistry } from '../../engine-host/registries/registry.js';
import { createRunStarter } from '../../engine-host/registries/run-starter.js';
import { createEffortTracker } from '../../engine-host/registries/effort.js';
import { temporalWorkflowStarter } from '../../engine-host/temporal/workflow-starter.js';
import { engineProvisionRuns } from '../../engine-host/provision-runs.js';
import { createProvisionOperations } from '../../extensions/provision/operations/handlers.js';
import { provisionPiecesOn } from '../../extensions/provision/pieces.js';
import { PROVISION_AGENT } from '../../extensions/provision/names.js';
import { ProvisionPieceActivity, recordedLines, type ProvisionPieceRun, type ProvisionPlace } from '../../activities/ProvisionPieceActivity.js';
import type { MoveOverDeps } from '../../activities/move-over.js';
import type { ClusterSteps } from '../../activities/cluster-steps.js';
import { koalaInstallActivities } from '../../activities/KoalaInstallActivities.js';
import { temporalInstallWorkflows } from '../../machines/wiring/sides.js';
import { koalaInstallWorkflowId } from '../../instances/lib/koala-installs.js';
import { InstanceReporter } from '../../instances/services/InstanceReporter.js';
import { rootInstallsServed } from '../../instances/testing/root-installs.js';
import { ClusterAccess, InfrastructureService, terraformPlacesFor, type ProvisioningRecord } from '../index.js';
import { privateCluster, type PrivateCluster } from '../testing/private-cluster.js';
import { CLUSTER_TOOL_PATHS } from '../services/ClusterAccess.js';
import { Provisioning } from '../services/Provisioning.js';

const WORLD = `provision-to-root-${randomUUID().slice(0, 8)}`;
const ENGINE_QUEUE = `${WORLD}-engine`;
const CLUSTER_QUEUE = `${WORLD}-cluster`;
const ROOT_QUEUE = `${WORLD}-root`;
const DESK = { id: 'desk', name: 'desk', meshIp: '100.64.0.7' };

let env: TestWorkflowEnvironment;
let k3s: PrivateCluster;
let workers: Worker[] = [];
let running: Promise<void>[] = [];
const closing: (() => Promise<void>)[] = [];

function engineActivities(instance: Database) {
  const registry = createAgentRegistry();
  const operations = createProvisionOperations({ records: instance.infrastructure, pieces: provisionPiecesOn({ client: async () => env.client, queue: CLUSTER_QUEUE }) });
  const tracker = createEffortTracker({ models: { resolveBaseUrl: async () => ({ provider: { id: 'none', name: 'none', source: 'deployment', model: 'none', contextTokens: 1 } as ModelProvider, baseUrl: 'http://none.test/v1' }) }, registry, store: { save: async () => undefined, list: async () => [] } });
  return {
    registry,
    engine: {
      EngineRunLimitsActivity: (args: Parameters<typeof tracker.limits>[0]) => tracker.limits(args),
      EngineRecordEffortActivity: (effort: Parameters<typeof tracker.record>[0]) => tracker.record(effort),
      EngineSettleClaimsActivity: async () => [] as string[],
      EngineToolAllowedActivity: async () => false,
      EngineAutoModeActivity: async () => false,
      EngineRecordTracesActivity: async () => undefined,
      EngineNodeActivity: createNodeRunner(createHostOpNodes({ operations } as never), undefined),
      EngineResolveAgentActivity: createEngineActivities({ registry, machineProblem: async () => undefined } as never).EngineResolveAgentActivity,
    },
    stream: {
      EngineStreamNodeActivity: createNodeRunner([], undefined),
      EnginePublishActivity: async () => undefined,
      EngineLifecycleActivity: async () => undefined,
    },
  };
}

function clusterSteps(): { steps: Pick<ClusterSteps, 'access' | 'infra' | 'database' | 'machineMetricsUrl'>; place: ProvisionPlace } {
  const access = new ClusterAccess({
    here: { koalaMachineId: 'desk', root: false },
    folder: mkdtempSync(join(tmpdir(), 'koala-provision-to-root-')),
    processes: nodeProcesses, streams: nodeStreams, tools: CLUSTER_TOOL_PATHS, serviceAccount: k3s.account,
  });
  const dataDir = testDataDir();
  mkdirSync(dataDir, { recursive: true });
  return {
    steps: {
      access,
      infra: new InfrastructureService(terraformPlacesFor({ kind: 'local' }, dataDir)),
      database: { mongo: { uri: 'mongodb://unused', dbName: 'unused' }, dataKey: 'unused' },
      machineMetricsUrl: { off: 'this test sets up no other machine' },
    },
    place: { koalaNamespace: 'nowrinkles', pool: false, dataDir, crawl4aiToken: 'crawlToken40' },
  };
}

async function rootSide(rootDb: Database) {
  const workflows = temporalInstallWorkflows(async () => env.client, ROOT_QUEUE);
  const { instances, url } = await rootInstallsServed(rootDb, workflows, closing);
  return { instances, workflows, url };
}

beforeAll(async () => {
  env = await realTemporalEnvironment();
  k3s = await privateCluster(import.meta.filename);
}, 0);

afterAll(async () => {
  for (const close of closing.splice(0).reverse()) await close();
  for (const worker of workers) worker.shutdown();
  await Promise.all(running);
  await k3s?.stop();
  await env?.teardown();
}, 0);

describe('Koala setting itself up after its chart, from the backend\'s start to root calling it ready', () => {
  it('runs the provision procedure as the persona\'s run, applies the egress proxy on a real cluster, keeps its lines on the record, and root turns the install ready once it hears the setup is done', async () => {
    const instanceDb = await testDatabase();
    const rootDb = await testDatabase();
    const { steps, place } = clusterSteps();
    const root = await rootSide(rootDb);

    const placed = await root.instances.placeOn('bo', DESK, 'bobby', 'install-1');
    if (!placed.ok) throw new Error(placed.error);
    const koala = await root.instances.placedKoala('install-1', DESK);
    if (!koala.ok) throw new Error(koala.error);

    const lines = recordedLines(instanceDb.infrastructure);
    const applied: string[] = [];
    const { registry, engine, stream } = engineActivities(instanceDb);
    const connection = env.nativeConnection;
    const namespace = env.namespace ?? 'default';
    workers = [
      await Worker.create({ ...WORKER_DEFAULTS, connection, namespace, taskQueue: ENGINE_QUEUE, interceptors: { activity: activityInterceptors() }, workflowBundle: await bundled(resolve(import.meta.dirname, '../../workflows/AgentRunWorkflow.ts')), activities: engine }),
      await Worker.create({ ...WORKER_DEFAULTS, connection, namespace, taskQueue: DEFAULT_STREAM_TASK_QUEUE, interceptors: { activity: activityInterceptors() }, activities: stream }),
      await Worker.create({
        ...WORKER_DEFAULTS, connection, namespace, taskQueue: CLUSTER_QUEUE, interceptors: { activity: activityInterceptors() },
        workflowBundle: await bundled(resolve(import.meta.dirname, '../../workflows/ProvisionPieceWorkflow.ts')),
        activities: {
          ProvisionPieceActivity: async (run: ProvisionPieceRun) => {
            applied.push(run.piece);
            if (run.piece === 'egress') return ProvisionPieceActivity(run, { steps, place, lines, moveOver: mock<MoveOverDeps>() });
            await lines.heard(run, { state: 'started', line: `${run.piece} is left to its own suite in this test` });
          },
        },
      }),
      await Worker.create({ ...WORKER_DEFAULTS, connection, namespace, taskQueue: ROOT_QUEUE, interceptors: { activity: activityInterceptors() }, workflowBundle: await bundled(resolve(import.meta.dirname, '../../workflows/KoalaInstallWorkflow.ts')), activities: koalaInstallActivities({ db: async () => ({ db: rootDb, close: async () => undefined }), now: () => new Date() }) }),
    ];
    running = workers.map((worker) => worker.run());

    await root.workflows.start('install-1', 'bo');
    await root.workflows.progress('install-1', { stage: 'koala', title: 'Koala', state: 'done', url: 'https://bobby.koala.test' });
    const rootRecord = async () => (await rootDb.instances.getInstances('bo'))[0]!;
    while ((await rootRecord()).install?.koalaUp !== true) await new Promise((done) => setTimeout(done, 200));
    expect(await rootRecord()).toMatchObject({ status: 'installing', install: { state: 'installing' } });

    const seen: ProvisioningRecord[] = [];
    const watching = instanceDb.infrastructure.watchProvisioning((record) => { seen.push(record); });
    await watching.ready;
    closing.push(() => watching.close());

    const provisioning = new Provisioning({
      store: instanceDb.infrastructure,
      runs: engineProvisionRuns({
        runs: createRunStarter({ registry, workflows: () => temporalWorkflowStarter(env.client.workflow), taskQueue: ENGINE_QUEUE }),
        client: () => env.client.workflow,
        agent: PROVISION_AGENT,
      }),
      root: new InstanceReporter({ root: { url: root.url, instanceId: placed.value.instanceId, credential: koala.value.credential }, wait: reopening(1), log: () => undefined }),
      koala: { ownerId: 'bo', clusterId: 'machine-desk', revision: 1 },
      changed: () => undefined,
      log: (line) => { console.warn(line); },
    });
    closing.push(() => provisioning.close());
    await provisioning.start();

    const [record] = await instanceDb.infrastructure.getProvisioning('machine-desk');
    expect(await provisioning.settled(record!.id)).toEqual({ state: 'up' });
    await provisioning.close();
    expect(await env.client.workflow.getHandle(koalaInstallWorkflowId('install-1')).result()).toBe('ready');

    expect(applied).toEqual(['egress', 'searxng', 'crawl4ai', 'gitea', 'verdaccio', 'infisical', 'monitoring']);
    expect(seen.some((each) => each.pieces.some((piece) => piece.key === 'egress' && piece.state === 'working' && piece.line === 'the egress proxy: ready'))).toBe(true);
    expect(await instanceDb.infrastructure.getProvisioningRun(record!.id)).toMatchObject({ state: 'up', workflowId: expect.any(String) as unknown });
    expect(await steps.access.kubectl(steps.access.own(), ['get', 'deployment', 'egress-proxy', '-n', 'koala-egress', '-o', 'jsonpath={.status.availableReplicas}'])).toBe('1');
    expect(await rootRecord()).toMatchObject({ status: 'ready', url: 'https://bobby.koala.test', install: { state: 'ready', setUp: true, koalaUp: true } });
  }, 0);
});
