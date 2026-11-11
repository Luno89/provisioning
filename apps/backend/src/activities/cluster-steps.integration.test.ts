import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { nodeProcesses, nodeStreams } from '../platform/index.js';
import { ClusterAccess, startedMachine, type Reach } from '../infrastructure/index.js';
import { applyWatched, CannotRollOut } from './watched-apply.js';
import { VerifyGpuRuntimeActivity } from './VerifyGpuRuntimeActivity.js';
import { DownloadModelActivity } from './DownloadModelActivity.js';
import { startHuggingFaceStandIn, STAND_IN_IMAGE, type HuggingFaceStandIn } from '../infrastructure/testing/hugging-face-stand-in.js';
import { InfrastructureService } from '../infrastructure/services/InfrastructureService.js';
import { InfisicalService } from '../infrastructure/services/InfisicalService.js';
import { GiteaService } from '../projects/services/GiteaService.js';
import { TOOLS } from '../infrastructure/testing/real-k3s.js';
import { ODOO_PROJECT_APP } from '../releases/index.js';
import { CheckWorkloadActivity } from './CheckWorkloadActivity.js';
import type { ClusterSteps } from './cluster-steps.js';
import { DestroyAppActivity } from './DestroyAppActivity.js';
import { ResizeDiskActivity } from './ResizeDiskActivity.js';
import { mongoTarget } from '../platform/lib/mongo-target.js';

const REPO = path.resolve(import.meta.dirname, '../../../../');
const CDKTF = path.join(REPO, 'packages', 'cdktf-infra');
const k3s = inject('k3s');

const access = new ClusterAccess({
  here: { koalaMachineId: 'dev1', root: false },
  folder: mkdtempSync(path.join(tmpdir(), 'koala-cluster-steps-')),
  processes: nodeProcesses,
  streams: nodeStreams,
  tools: TOOLS,
  serviceAccount: k3s.account,
});
const KOALA: Reach = access.own();
const DESK: Reach = startedMachine('machine-desk', k3s.admin);
const exists = async (reach: Reach, namespace: string) => (await access.kubectl(reach, ['get', 'namespace', namespace, '--ignore-not-found', '-o', 'name'])).trim() !== '';

let root: string;
let steps: ClusterSteps;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'koala-cluster-steps-cdktf-'));
  const cdktfDir = path.join(root, 'app');
  const runsDir = path.join(root, 'runs');
  await mkdir(cdktfDir, { recursive: true });
  await mkdir(runsDir, { recursive: true });
  await symlink(path.join(REPO, 'node_modules'), path.join(cdktfDir, 'node_modules'));
  const cdktf = createRequire(path.join(CDKTF, 'package.json')).resolve('cdktf');
  await writeFile(path.join(cdktfDir, 'cdktf.json'), JSON.stringify({ language: 'typescript', app: `${path.join(REPO, 'node_modules', '.bin', 'tsx')} app.ts`, sendCrashReports: 'false', terraformProviders: [] }));
  await writeFile(path.join(cdktfDir, 'app.ts'), [
    `import { App, TerraformStack } from ${JSON.stringify(cdktf)};`,
    `import { K8sProviderService } from ${JSON.stringify(path.join(CDKTF, 'lib', 'k8s-provider-service.ts'))};`,
    `import { Namespace } from ${JSON.stringify(path.join(CDKTF, '.gen', 'providers', 'kubernetes', 'namespace', 'index.ts'))};`,
    `import { DeploymentV1 } from ${JSON.stringify(path.join(CDKTF, '.gen', 'providers', 'kubernetes', 'deployment-v1', 'index.ts'))};`,
    `import { keepState } from ${JSON.stringify(path.join(CDKTF, 'lib', 'state.ts'))};`,
    'const app = new App();',
    'const stack = new TerraformStack(app, `app-${process.env.CLUSTER_NAME}-${process.env.DEPLOYMENT_ID}`);',
    'K8sProviderService.fromEnv(stack);',
    'const ns = new Namespace(stack, "ns", { metadata: { name: process.env.DEPLOYMENT_NAME!, labels: { app: process.env.APP_TYPE ?? "none" } } });',
    'if (process.env.STUCK_IMAGE) new DeploymentV1(stack, "stuck", { dependsOn: [ns], waitForRollout: true, metadata: { name: "stuck", namespace: process.env.DEPLOYMENT_NAME! }, spec: { selector: { matchLabels: { app: "stuck" } }, template: { metadata: { labels: { app: "stuck" } }, spec: { container: [{ name: "stuck", image: process.env.STUCK_IMAGE }] } } } });',
    'keepState(app, process.env);',
    'app.synth();',
    '',
  ].join('\n'));
  steps = { access, infra: new InfrastructureService({ cdktfDir, stateDir: path.join(root, 'state'), runsDir, home: { kind: 'local', dir: path.join(root, 'state') } }), gitea: new GiteaService('integration-key' as never, { none: 'the apps these tests deploy are not built in Gitea' }), infisical: new InfisicalService('integration-key' as never, { none: 'the apps these tests deploy keep no secrets in Infisical' }), database: { mongo: mongoTarget(process.env), dataKey: 'integration-key' }, machineMetricsUrl: { off: 'these tests deploy to no other machine' } };
});

afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe('cluster steps against a real k3s, through ClusterAccess', () => {
  it('reads a workload through the cluster it was handed, and says when the cluster refuses to make its pods', async () => {
    await access.kubectl(DESK, ['create', 'namespace', 'quota-shop']);
    await access.kubectl(DESK, ['create', 'quota', 'none', '-n', 'quota-shop', '--hard=pods=0']);
    await access.kubectl(DESK, ['create', 'deployment', 'shop', '-n', 'quota-shop', '--image=registry.k8s.io/pause:3.9']);
    const check = () => CheckWorkloadActivity({ name: 'shop', namespace: 'quota-shop', clusterId: DESK.clusterId, reach: DESK }, steps);
    let read = await check();
    while (read.health === 'starting') read = await check();
    expect(read.health).toBe('unhealthy');
    expect(read.reason).toContain('exceeded quota');
  }, 60_000);

  it('says a workload could not be read when the machine it was handed answers nowhere', async () => {
    const nowhere = startedMachine('machine-gone', k3s.admin.replace(/server: https:\/\/127\.0\.0\.1:\d+/, 'server: https://127.0.0.1:1'));
    const read = await CheckWorkloadActivity({ name: 'shop', clusterId: 'machine-gone', reach: nowhere }, steps);
    expect(read.health).toBe('unknown');
    expect(read.reason).toContain('127.0.0.1:1');
  }, 60_000);

  it('removes an Odoo release and its namespace on the cluster it was handed', async () => {
    await access.kubectl(DESK, ['create', 'namespace', 'odoo-shop']);
    await DestroyAppActivity({ name: 'shop', namespace: 'odoo-shop', deploymentId: 'shop', clusterId: DESK.clusterId, clusterName: 'desk', strategy: 'native', appType: ODOO_PROJECT_APP, logFile: path.join(root, 'odoo.log'), reach: DESK }, steps);
    expect(await exists(DESK, 'odoo-shop')).toBe(false);
  }, 120_000);

  it('applies an app\'s stack with Terraform through the kubeconfig Koala\'s own service account makes, then removes it the same way', async () => {
    const app = { name: 'books', namespace: 'books-1a2b3c', deploymentId: 'd1', clusterId: KOALA.clusterId, clusterName: 'own', strategy: 'native', logFile: path.join(root, 'books.log'), reach: KOALA };
    await ResizeDiskActivity({ ...app, appType: 'audiobookshelf', storage: {} }, steps);
    expect(await access.kubectl(KOALA, ['get', 'namespace', 'books-1a2b3c', '-o', 'jsonpath={.metadata.labels.app}'])).toBe('audiobookshelf');
    await DestroyAppActivity({ ...app, appType: 'audiobookshelf' }, steps);
    expect(await exists(KOALA, 'books-1a2b3c')).toBe(false);
  }, 300_000);

  it('stops Terraform the moment what it applies can never roll out, saying why, rather than waiting on it', async () => {
    const env = { CLUSTER_NAME: 'desk', DEPLOYMENT_ID: 'd9', DEPLOYMENT_NAME: 'stuck-9a8b7c', KUBECONFIG: await access.kubeconfigOf(DESK), STUCK_IMAGE: 'registry.invalid/koala/none:1' };
    const told: string[] = [];
    const failed = await applyWatched(steps, 'app-desk-d9', { env, logFile: path.join(root, 'stuck.log') }, { what: 'stuck', reach: DESK, namespaces: ['stuck-9a8b7c'], log: (line) => told.push(line) }, (ms) => new Promise((done) => { setTimeout(done, Math.min(ms, 300)); }))
      .then(() => undefined, (err: unknown) => err);
    expect(failed).toBeInstanceOf(CannotRollOut);
    expect((failed as CannotRollOut).why).toMatch(/pull|image/i);
    await access.kubectl(DESK, ['delete', 'namespace', 'stuck-9a8b7c', '--wait=false']);
  }, 600_000);

  it('applies the NVIDIA device plugin on a machine with no NVIDIA runtime, and fails with what to do rather than wait', async () => {
    try {
      await expect(VerifyGpuRuntimeActivity({ clusterId: DESK.clusterId, reach: DESK, vendor: 'nvidia', count: 1, machine: 'desk' }, steps, (ms) => new Promise((done) => { setTimeout(done, Math.min(ms, 500)); })))
        .rejects.toThrow(/the NVIDIA device plugin cannot run on desk: .*nvidia.*restart k3s on it/s);
    } finally {
      await access.kubectl(DESK, ['delete', 'daemonset', 'nvidia-device-plugin-daemonset', '-n', 'kube-system', '--ignore-not-found', '--wait=false']);
    }
  }, 300_000);

  it('applies an app\'s stack with Terraform on another machine through the kubeconfig its workflow handed over', async () => {
    const app = { name: 'notes', namespace: 'notes-4d5e6f', deploymentId: 'd2', clusterId: DESK.clusterId, clusterName: 'desk', strategy: 'native', logFile: path.join(root, 'notes.log'), reach: DESK };
    await ResizeDiskActivity({ ...app, appType: 'papra', storage: {} }, steps);
    expect(await exists(DESK, 'notes-4d5e6f')).toBe(true);
    await DestroyAppActivity({ ...app, appType: 'papra' }, steps);
    expect(await exists(DESK, 'notes-4d5e6f')).toBe(false);
  }, 300_000);
});

describe('a model downloaded on the machine that runs it', () => {
  const cache = `/var/lib/rancher/koala-test-models-${Math.random().toString(36).slice(2, 8)}`;
  let standIn: HuggingFaceStandIn;

  beforeAll(async () => { standIn = await startHuggingFaceStandIn(access, DESK); }, 600_000);
  afterAll(async () => { await standIn.stop(); });

  const download = (modelRepo: string) => DownloadModelActivity({ clusterId: DESK.clusterId, reach: DESK, image: STAND_IN_IMAGE, modelRepo, cacheHostPath: cache }, { access }, standIn.endpoint, 500);

  it('fetches the model\'s files into the machine\'s cache folder, and finds them there the next time', async () => {
    expect(await download('acme/tiny')).toEqual({ skipped: false, modelDir: `${cache}/acme-tiny` });
    expect(await download('acme/tiny')).toEqual({ skipped: true, modelDir: `${cache}/acme-tiny` });
  }, 600_000);

  it('fails with what to check: a model with no files, one Hugging Face does not have, one without config.json', async () => {
    await expect(download('acme/empty')).rejects.toThrow(/no files found for acme\/empty@main/);
    await expect(download('acme/unknown')).rejects.toThrow(/Hugging Face answered 404/);
    await expect(download('acme/noconfig')).rejects.toThrow(/config\.json is missing after downloading acme\/noconfig@main/);
  }, 600_000);
});
