import { activityInterceptors } from '@koala/engine-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WORKER_DEFAULTS } from '@koala/engine-core';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { CheckWorkloadActivity, type CheckWorkloadArgs } from '../activities/CheckWorkloadActivity.js';
import type { ClusterSteps } from '../activities/cluster-steps.js';
import type { DeployAppArgs } from '../activities/DeployAppActivity.js';
import { clusterActivities, type ClusterSetup } from '../worker-cluster.js';
import { http, HttpResponse } from 'msw';
import { interceptHttp } from '../platform/testing/http.js';
import { DestroyAppActivity, type DestroyAppArgs } from '../activities/DestroyAppActivity.js';
import { handedReach } from '../activities/handed-reach.js';
import { ClusterAccess } from '../infrastructure/services/ClusterAccess.js';
import { InfrastructureService, terraformPlacesFor } from '../infrastructure/services/InfrastructureService.js';
import { InfisicalService } from '../infrastructure/services/InfisicalService.js';
import { GiteaService } from '../projects/services/GiteaService.js';
import { TOOLS } from '../infrastructure/testing/real-k3s.js';
import { nodeProcesses, nodeStreams } from '../platform/index.js';
import { startedFor } from '../platform/lib/workflow-owner.js';
import { ODOO_PROJECT_APP } from '../releases/index.js';
import { bundled, temporalTestEnvironment } from './temporal-test-env.js';
import type { executeDeployAppWorkflow } from './AppDeployWorkflow.js';
import type { executeDestroyAppWorkflow } from './DestroyAppWorkflow.js';
import { mongoTarget } from '../platform/lib/mongo-target.js';
import { testDataDir } from '../platform/testing/data-dir.js';

const NO_SETUP: ClusterSetup = { place: { koalaNamespace: 'koala', pool: false, dataDir: '/nowhere', crawl4aiToken: 'unused' }, lines: { heard: async () => { throw new Error('this test sets no Koala up') } }, provisioner: { ensure: async () => { throw new Error('this test sets no Koala up') }, settled: async () => { throw new Error('this test sets no Koala up') } }, moveOver: { instanceId: 'unused', steps: {} as never, parts: () => { throw new Error('this test moves no Koala') }, records: { getMoveIn: async () => { throw new Error('this test moves no Koala') }, saveMoveIn: async () => { throw new Error('this test moves no Koala') } } } };

const k3s = inject('k3s');
const QUEUE = `app-deploy-k3s-${Math.random().toString(36).slice(2, 8)}`;
const access = new ClusterAccess({
  here: { koalaMachineId: 'dev1', root: false },
  folder: mkdtempSync(join(tmpdir(), 'koala-app-deploy-wf-')),
  processes: nodeProcesses,
  streams: nodeStreams,
  tools: TOOLS,
  serviceAccount: k3s.account,
});
const steps: ClusterSteps = { access, infra: new InfrastructureService(terraformPlacesFor({ kind: 'local' }, testDataDir())), gitea: new GiteaService('integration-key' as never, { none: 'the apps these tests deploy are not built in Gitea' }, { dataDir: testDataDir() }), infisical: new InfisicalService('integration-key' as never, { none: 'the apps these tests deploy keep no secrets in Infisical' }, testDataDir()), database: { mongo: mongoTarget(process.env), dataKey: 'integration-key' }, machineMetricsUrl: { off: 'these tests deploy to no other machine' } };
const KOALA = access.own();
const LOG = join(mkdtempSync(join(tmpdir(), 'koala-app-deploy-wf-log-')), 'app.log');
const deployed: Array<{ clusterId: string; reach: unknown }> = [];

let env: TestWorkflowEnvironment;
let bundle: Awaited<ReturnType<typeof bundled>>;

const placedRefused = async (args: DeployAppArgs) => {
  const reach = handedReach(args);
  deployed.push({ clusterId: args.clusterId, reach });
  const namespace = args.namespace!;
  await access.kubectl(reach, ['create', 'namespace', namespace]);
  await access.kubectl(reach, ['create', 'quota', 'none', '-n', namespace, '--hard=pods=0']);
  await access.kubectl(reach, ['create', 'deployment', args.name, '-n', namespace, '--image=registry.k8s.io/pause:3.9']);
  await access.kubectl(reach, ['wait', `deployment/${args.name}`, '-n', namespace, '--for=condition=ReplicaFailure', '--timeout=720h']);
  return { status: 'running', msg: 'deployed', displayUrl: '' };
};

beforeAll(async () => {
  env = await temporalTestEnvironment();
  bundle = await bundled(resolve(import.meta.dirname, 'index.ts'));
}, 120_000);

const huggingFace = interceptHttp();

async function working<T>(work: Promise<T>, deployApp: (args: DeployAppArgs) => Promise<unknown> = placedRefused): Promise<T> {
  const worker = await Worker.create({
    interceptors: { activity: activityInterceptors() },
    ...WORKER_DEFAULTS, connection: env.nativeConnection, namespace: env.namespace ?? 'default', taskQueue: QUEUE,
    workflowBundle: bundle,
    activities: {
      DeployAppActivity: deployApp,
      CheckWorkloadActivity: (args: CheckWorkloadArgs) => CheckWorkloadActivity(args, steps),
      DestroyAppActivity: (args: DestroyAppArgs) => DestroyAppActivity(args, steps),
    },
  });
  return worker.runUntil(work);
}

afterAll(async () => { await env?.teardown(); });

const deploy = (args: Partial<DeployAppArgs>) => env.client.workflow.execute<typeof executeDeployAppWorkflow>('executeDeployAppWorkflow', {
  taskQueue: QUEUE, workflowId: `deploy-${Math.random().toString(36).slice(2, 8)}`, ...startedFor('bo'),
  args: [{ name: 'shop', namespace: 'shop-1a2b3c', deploymentId: 'shop', clusterId: KOALA.clusterId, clusterName: 'own', provider: 'machine', strategy: 'native', appType: 'wordpress', odooRepo: '', odooTag: '', dbRepo: '', dbTag: '', logFile: LOG, ...args } as DeployAppArgs],
});

const destroy = (args: Partial<DestroyAppArgs>) => env.client.workflow.execute<typeof executeDestroyAppWorkflow>('executeDestroyAppWorkflow', {
  taskQueue: QUEUE, workflowId: `destroy-${Math.random().toString(36).slice(2, 8)}`, ...startedFor('bo'),
  args: [{ name: 'shop', namespace: 'shop-1a2b3c', deploymentId: 'shop', clusterId: KOALA.clusterId, clusterName: 'own', provider: 'machine', strategy: 'native', appType: ODOO_PROJECT_APP, logFile: LOG, ...args } as DestroyAppArgs],
});

describe('deploying and removing an app through Temporal on a real k3s, with the reach its starter handed over', () => {
  it('hands the reach to the deploy and to every check of its workload, which reads the cluster through it and says why the app cannot run', async () => {
    const outcome = await working(deploy({ reach: KOALA }));
    expect(deployed).toEqual([{ clusterId: KOALA.clusterId, reach: KOALA }]);
    expect(outcome).toMatchObject({ status: 'running', workload: 'unhealthy' });
    expect(outcome.workloadReason).toContain('exceeded quota');
  }, 120_000);

  it('removes the app on the cluster it was handed, its namespace with it', async () => {
    await working(destroy({ reach: KOALA }));
    expect((await access.kubectl(KOALA, ['get', 'namespace', 'shop-1a2b3c', '--ignore-not-found', '-o', 'name'])).trim()).toBe('');
  }, 120_000);

  it('refuses work started with no way to reach its cluster, as a release before this one started it, and runs no step', async () => {
    deployed.length = 0;
    await expect(working(deploy({}))).rejects.toMatchObject({ cause: { message: expect.stringContaining('this work was started with no way to reach machine-dev1') as unknown } });
    expect(deployed).toEqual([]);
  }, 60_000);
});

describe('a TabbyAPI app whose model\'s size Hugging Face cannot say, deployed through Temporal', () => {
  it('stops at the deploy step, saying what to set, and sizes nothing on a guess', async () => {
    huggingFace.use(http.get('https://huggingface.co/api/models/org/model/tree/*', () => new HttpResponse(null, { status: 503 })));
    await expect(working(deploy({ reach: KOALA, name: 'qwen', namespace: 'qwen-1a2b3c', appType: 'tabbyapi', tabbyModel: 'org/model', tabbyGpuCount: 0 }), clusterActivities(steps, NO_SETUP).DeployAppActivity))
      .rejects.toMatchObject({ cause: { cause: { message: expect.stringMatching(/^Koala could not read how big org\/model is from Hugging Face \(.*503.*\), so it cannot size the memory it needs\. Set its Memory Limit \(RAM\) and Shared Memory/) as unknown } } });
  }, 120_000);
});
