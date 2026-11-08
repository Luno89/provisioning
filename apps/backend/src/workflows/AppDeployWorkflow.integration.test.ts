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
import { DestroyAppActivity, type DestroyAppArgs } from '../activities/DestroyAppActivity.js';
import { handedReach } from '../activities/handed-reach.js';
import { ClusterAccess } from '../infrastructure/services/ClusterAccess.js';
import { InfrastructureService } from '../infrastructure/services/InfrastructureService.js';
import { InfisicalService } from '../infrastructure/services/InfisicalService.js';
import { GiteaService } from '../projects/services/GiteaService.js';
import { TOOLS } from '../infrastructure/testing/real-k3s.js';
import { nodeProcesses, nodeStreams } from '../platform/index.js';
import { startedFor } from '../platform/lib/workflow-owner.js';
import { ODOO_PROJECT_APP } from '../releases/index.js';
import { bundled, temporalTestEnvironment } from './temporal-test-env.js';
import type { executeDeployAppWorkflow } from './AppDeployWorkflow.js';
import type { executeDestroyAppWorkflow } from './DestroyAppWorkflow.js';

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
const steps: ClusterSteps = { access, infra: new InfrastructureService(), gitea: new GiteaService('integration-key' as never, { none: 'the apps these tests deploy are not built in Gitea' }), infisical: new InfisicalService('integration-key' as never, { none: 'the apps these tests deploy keep no secrets in Infisical' }) };
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
  while (!(await access.kubectl(reach, ['get', 'replicasets', '-n', namespace, '-o', 'jsonpath={.items[*].status.conditions[*].reason}'])).includes('FailedCreate'));
  return { status: 'running', msg: 'deployed', displayUrl: '' };
};

beforeAll(async () => {
  env = await temporalTestEnvironment();
  bundle = await bundled(resolve(import.meta.dirname, 'index.ts'));
}, 120_000);

async function working<T>(work: Promise<T>): Promise<T> {
  const worker = await Worker.create({
    ...WORKER_DEFAULTS, connection: env.nativeConnection, namespace: env.namespace ?? 'default', taskQueue: QUEUE,
    workflowBundle: bundle,
    activities: {
      DeployAppActivity: placedRefused,
      CheckWorkloadActivity: (args: CheckWorkloadArgs) => CheckWorkloadActivity(args, steps),
      DestroyAppActivity: (args: DestroyAppArgs) => DestroyAppActivity(args, steps),
    },
  });
  return worker.runUntil(work);
}

afterAll(async () => { await env?.teardown(); });

const deploy = (args: Partial<DeployAppArgs>) => env.client.workflow.execute<typeof executeDeployAppWorkflow>('executeDeployAppWorkflow', {
  taskQueue: QUEUE, workflowId: `deploy-${Math.random().toString(36).slice(2, 8)}`, ...startedFor('bo'),
  args: [{ name: 'shop', namespace: 'shop-1a2b3c', clusterId: KOALA.clusterId, clusterName: 'own', provider: 'machine', strategy: 'native', appType: 'wordpress', odooRepo: '', odooTag: '', dbRepo: '', dbTag: '', logFile: LOG, ...args } as DeployAppArgs],
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
