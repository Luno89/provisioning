import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { activityInterceptors, WORKER_DEFAULTS } from '@koala/engine-core';
import { createDeviceActivities } from '../../../local-agent/src/engine-worker.js';
import { IdleGate } from '../../../local-agent/src/idle-gate.js';
import { K3S_KUBECONFIG, K3S_MARKER, runMachineCluster, type ClusterHost } from '../../../local-agent/src/machine-cluster.js';
import { bundled, temporalTestEnvironment } from './temporal-test-env.js';
import { emptiedEachTime } from '../platform/lib/test-database.js';
import type { MongoDB } from '../platform/lib/mongo-db.js';
import { decryptValue } from '../platform/lib/crypto.js';
import { startedFor } from '../platform/lib/workflow-owner.js';
import type { DeploymentMetadata } from '../platform/lib/types.js';
import { createStreamActivities, type StreamServices } from '../engine-host/temporal/activities.js';
import { DEFAULT_STREAM_TASK_QUEUE, deviceQueue } from '../engine-host/temporal/contracts.js';
import { MachineClusters } from '../machines/services/MachineClusters.js';
import type { DeployAppArgs } from '../activities/DeployAppActivity.js';
import type { DestroyAppArgs } from '../activities/DestroyAppActivity.js';
import type { executeDeployAppWorkflow } from './AppDeployWorkflow.js';
import type { executeDestroyAppWorkflow } from './DestroyAppWorkflow.js';

const KEY = 'machine-cluster-workflow-key';
const QUEUE = 'machine-cluster-workflow-test';
const DESK = { id: 'desk', ownerId: 'bo', name: 'desk', meshIp: '100.64.0.7' };
const fresh = await emptiedEachTime();

class DeskHost implements ClusterHost {
  active = false;
  startedAt = 0;
  wantedNow = false;
  clock = Date.parse('2026-11-05T12:00:00Z');
  busyWhileStarting: string[] = [];
  constructor(private readonly gate: IdleGate) {}
  async list(): Promise<string[]> { return []; }
  async run(file: string, args: string[]): Promise<string> {
    const line = [file, ...args].join(' ');
    if (line === 'sudo -n systemctl start k3s') {
      this.busyWhileStarting = this.gate.busyWith();
      this.active = true;
      this.startedAt = this.clock;
      return '';
    }
    if (line === 'sudo -n systemctl stop k3s') { this.active = false; return ''; }
    if (line.startsWith('sudo -n ') && line.endsWith('k3s-killall.sh')) return '';
    if (line === 'systemctl show k3s --property=ActiveState --value') return this.active ? 'active\n' : 'inactive\n';
    if (line.includes(' get nodes ') || line.includes(' get pod ')) return this.active ? `True ${new Date(this.startedAt + 5_000).toISOString()}` : '';
    throw new Error(`the desk was asked to run what a machine's cluster never runs: ${line}`);
  }
  async exists(path: string): Promise<boolean> { return path === K3S_MARKER; }
  async read(path: string): Promise<string> {
    if (path !== K3S_KUBECONFIG) throw new Error(`the desk has no ${path}`);
    return 'clusters:\n- cluster:\n    server: https://127.0.0.1:6443\n';
  }
  async wanted(running: boolean): Promise<void> { this.wantedNow = running; }
  async isWanted(): Promise<boolean> { return this.wantedNow; }
  async holdKoala(): Promise<void> { throw new Error('no Koala is put on the desk here'); }
  async holdsKoala(): Promise<boolean> { return false; }
  async meshIp(): Promise<string | undefined> { return DESK.meshIp; }
  now(): number { return this.clock; }
  async pause(): Promise<void> { this.clock += 2_000; }
}

let env: TestWorkflowEnvironment;
let db: MongoDB;
let gate: IdleGate;
let host: DeskHost;
let clusters: MachineClusters;
let rootDir: string;
const handed: Array<{ activity: string; kubeconfig: string | undefined }> = [];

const app = (id: string): DeploymentMetadata => ({ id, name: id, clusterId: 'machine-desk', ownerId: 'bo', strategy: 'native', status: 'running' });

beforeAll(async () => { env = await temporalTestEnvironment(); rootDir = mkdtempSync(join(tmpdir(), 'machine-cluster-wf-')); }, 120_000);
afterAll(async () => { await env?.teardown(); rmSync(rootDir, { recursive: true, force: true }); });

beforeEach(async () => {
  db = await fresh();
  gate = new IdleGate();
  host = new DeskHost(gate);
  clusters = new MachineClusters({ store: db.infrastructure, dataKey: KEY });
  handed.length = 0;
  await clusters.reported(DESK, 'stopped');
});

async function working<T>(work: () => Promise<T>): Promise<T> {
  const connection = env.nativeConnection;
  const namespace = env.namespace ?? 'default';
  const services: StreamServices = { registry: {} as never, endpoints: {} as never, bus: {} as never, machineClusters: clusters };
  const workflows = await Worker.create({
    ...WORKER_DEFAULTS, interceptors: { activity: activityInterceptors() }, connection, namespace, taskQueue: QUEUE,
    workflowBundle: await bundled(resolve(__dirname, 'index.ts')),
    activities: {
      DeployAppActivity: async (args: DeployAppArgs) => { handed.push({ activity: 'deploy', kubeconfig: args.reach?.kind === 'machine' ? args.reach.kubeconfig : undefined }); return { status: 'deployed', msg: 'deployed', displayUrl: '' }; },
      CheckWorkloadActivity: async (args: DeployAppArgs) => { handed.push({ activity: 'check', kubeconfig: args.reach?.kind === 'machine' ? args.reach.kubeconfig : undefined }); return { health: 'healthy', reason: '' }; },
      DestroyAppActivity: async (args: DestroyAppArgs) => { handed.push({ activity: 'destroy', kubeconfig: args.reach?.kind === 'machine' ? args.reach.kubeconfig : undefined }); return { status: 'destroyed', msg: 'destroyed' }; },
    },
  });
  const stream = await Worker.create({
    ...WORKER_DEFAULTS, interceptors: { activity: activityInterceptors() }, connection, namespace, taskQueue: DEFAULT_STREAM_TASK_QUEUE,
    activities: createStreamActivities(services),
  });
  const device = await Worker.create({
    ...WORKER_DEFAULTS, connection, namespace, taskQueue: deviceQueue(DESK.id),
    interceptors: { activity: activityInterceptors() },
    activities: createDeviceActivities({ rootDir, deviceId: DESK.id, gate, cluster: (op) => runMachineCluster(host, op) }),
  });
  return workflows.runUntil(() => stream.runUntil(() => device.runUntil(work)));
}

const stored = async () => (await db.infrastructure.getClusters()).find((cluster) => cluster.id === 'machine-desk')!;
const ONE_MESH = 'clusters:\n- cluster:\n    server: https://100.64.0.7:6443\n';

const deploy = (name: string) => env.client.workflow.execute<typeof executeDeployAppWorkflow>('executeDeployAppWorkflow', {
  taskQueue: QUEUE, workflowId: `deploy-${name}-${Math.random().toString(36).slice(2, 8)}`, ...startedFor('bo'),
  args: [{ name, clusterId: 'machine-desk', clusterName: 'desk', provider: 'machine', strategy: 'native', appType: 'nginx', machine: { deviceId: DESK.id } } as unknown as DeployAppArgs],
});

const destroy = (name: string) => env.client.workflow.execute<typeof executeDestroyAppWorkflow>('executeDestroyAppWorkflow', {
  taskQueue: QUEUE, workflowId: `destroy-${name}-${Math.random().toString(36).slice(2, 8)}`, ...startedFor('bo'),
  args: [{ name, deploymentId: name, clusterId: 'machine-desk', clusterName: 'desk', provider: 'machine', strategy: 'native', appType: 'nginx', logFile: join(rootDir, 'destroy.log'), machine: { deviceId: DESK.id, leaving: name } } as unknown as DestroyAppArgs],
});

describe('a machine\'s own cluster under the deploy and destroy workflows', () => {
  it('a deploy starts k3s on the machine while it holds the machine busy, records it running with its kubeconfig sealed, and hands that kubeconfig to every cluster step', async () => {
    const outcome = await working(() => deploy('books'));
    expect(outcome).toMatchObject({ status: 'deployed', workload: 'healthy' });
    expect(host.active).toBe(true);
    expect(host.wantedNow).toBe(true);
    expect(host.busyWhileStarting).toEqual(['starting its cluster']);
    expect(gate.idle).toBe(true);
    const record = await stored();
    expect(record).toMatchObject({ status: 'healthy', meshIp: DESK.meshIp });
    expect(decryptValue(record.kubeconfigEnc!, KEY)).toBe(ONE_MESH);
    expect(handed).toEqual([{ activity: 'deploy', kubeconfig: ONE_MESH }, { activity: 'check', kubeconfig: ONE_MESH }]);
  }, 120_000);

  it('destroying the last app on it starts it to remove the app, then stops k3s and records it stopped', async () => {
    await db.infrastructure.saveDeployment(app('books'));
    await working(() => destroy('books'));
    expect(handed).toEqual([{ activity: 'destroy', kubeconfig: ONE_MESH }]);
    expect(host.active).toBe(false);
    expect(host.wantedNow).toBe(false);
    expect((await stored()).status).toBe('stopped');
  }, 120_000);

  it('destroying one app while another is still on it leaves k3s running', async () => {
    await db.infrastructure.saveDeployment(app('books'));
    await db.infrastructure.saveDeployment(app('notes'));
    await working(() => destroy('books'));
    expect(host.active).toBe(true);
    expect((await stored()).status).toBe('healthy');
  }, 120_000);
});
