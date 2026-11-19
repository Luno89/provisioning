import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import express, { type NextFunction, type Request, type Response } from 'express';
import { afterAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { PlacedKoala } from '@koala/engine-core/koala-install';
import type { MachineProgress } from '@koala/engine-core/machine-progress';
import { SETUP_LABEL } from '@koala/provision';
import { installKoala, KOALA_NAMESPACE, KOALA_RELEASE } from '../../../../local-agent/src/koala-install.js';
import { K3S_BINARY, K3S_KUBECONFIG, K3S_MARKER, hostCluster, type ClusterHost } from '../../../../local-agent/src/machine-cluster.js';
import { emptiedEachTime } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { TOOLS } from '../../infrastructure/testing/real-k3s.js';
import { InstanceService, type PlacingMachine } from '../../instances/services/InstanceService.js';
import { InstanceReach } from '../../instances/services/InstanceReach.js';
import { MoveRelay } from '../../instances/services/MoveRelay.js';
import { instancesRouter } from '../../instances/routes/instances.js';
import { keysEnv, MOVED_KEYS } from '../../instances/lib/instance-move.js';
import { MOVE_TOKEN_HEADER } from '../../instances/lib/identity-token.js';
import { KoalaInstalls } from '../services/KoalaInstalls.js';
import { machinesRouter } from '../routes/machines.js';
import { deviceTokenHash } from '../lib/device-tokens.js';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const REAL_CHART = resolve(here, '../../../../../charts/instance');
const k3s = inject('k3s');
const fresh = await emptiedEachTime();
const work = mkdtempSync(join(tmpdir(), 'koala-move-install-'));
const admin = join(work, 'admin.yaml');
writeFileSync(admin, k3s.admin, { mode: 0o600 });
const HELM = '/machine/koala/bin/helm';
const INSTANCE = 'inst-bobby';
const DEVICE_TOKEN = 'the-desk-token-0123456789-0123456789';
const POOL_KEYS = Object.fromEntries(MOVED_KEYS.map((name, at) => [name, `${name.toLowerCase().replace(/_/g, '-')}-of-the-pool-copy-${at}`]));

const kubectl = async (...args: string[]): Promise<string> => (await run(TOOLS.kubectl, ['--kubeconfig', admin, ...args])).stdout;
const helm = async (...args: string[]): Promise<string> => (await run(TOOLS.helm, [...args, '--kubeconfig', admin])).stdout;

afterAll(async () => {
  await kubectl('delete', 'namespace', KOALA_NAMESPACE, '--ignore-not-found', '--wait=true');
}, 0);

function movingChart(): string {
  const chart = join(work, 'chart');
  mkdirSync(join(chart, 'templates'), { recursive: true });
  writeFileSync(join(chart, 'Chart.yaml'), 'apiVersion: v2\nname: instance\nversion: 0.1.0\n');
  writeFileSync(join(chart, 'values.yaml'), 'move:\n  enabled: false\n  fromClusterId: ""\n');
  for (const file of ['_helpers.tpl', 'secret-keys.yaml']) copyFileSync(join(REAL_CHART, 'templates', file), join(chart, 'templates', file));
  writeFileSync(join(chart, 'templates', 'app.yaml'), [
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata:',
    '  name: {{ .Release.Name }}-backend',
    '  labels: { app.kubernetes.io/instance: {{ .Release.Name }} }',
    'spec:',
    '  replicas: {{ if .Values.move.enabled }}0{{ else }}1{{ end }}',
    '  selector: { matchLabels: { app.kubernetes.io/instance: {{ .Release.Name }} } }',
    '  template:',
    '    metadata: { labels: { app.kubernetes.io/instance: {{ .Release.Name }} } }',
    '    spec:',
    '      terminationGracePeriodSeconds: 0',
    '      containers: [{ name: app, image: busybox:1.37, command: [sleep, "100000"], envFrom: [{ secretRef: { name: {{ .Release.Name }}-keys } }] }]',
    '',
  ].join('\n'));
  writeFileSync(join(chart, 'templates', 'job-setup.yaml'), [
    'apiVersion: batch/v1',
    'kind: Job',
    'metadata:',
    '  name: {{ .Release.Name }}-setup-{{ .Release.Revision }}',
    `  labels: { app.kubernetes.io/instance: {{ .Release.Name }}, ${SETUP_LABEL}: setup }`,
    '  annotations: { helm.sh/resource-policy: keep }',
    'spec:',
    '  backoffLimit: 0',
    '  template:',
    '    metadata: { labels: { app.kubernetes.io/instance: {{ .Release.Name }} } }',
    '    spec:',
    '      restartPolicy: Never',
    '      terminationGracePeriodSeconds: 0',
    '      containers: [{ name: setup, image: busybox:1.37, command: [sh, -c, {{ ternary (printf "echo bringing Koala over from %s" .Values.move.fromClusterId) "echo seeded" .Values.move.enabled | quote }}] }]',
    '',
  ].join('\n'));
  return chart;
}

async function packagedChart(): Promise<string> {
  const packaged = join(work, 'packaged');
  await run(TOOLS.helm, ['package', movingChart(), '-d', packaged]);
  return join(packaged, readdirSync(packaged)[0]!);
}

const chartFile = await packagedChart();

function thisMachine(): ClusterHost {
  const files = mkdtempSync(join(work, 'machine-'));
  const host = hostCluster(async () => '100.64.0.7', { wantedAt: join(files, 'cluster-wanted'), koalaHere: join(files, 'koala-here') });
  const onTestK3s = (args: readonly string[]) => args.map((arg) => (arg === K3S_KUBECONFIG ? admin : arg));
  return {
    ...host,
    exists: async (file) => (file === K3S_MARKER ? true : host.exists(file)),
    read: async (file) => (file === K3S_KUBECONFIG ? k3s.admin : host.read(file)),
    run: async (file, args) => {
      if (file === 'systemctl') return 'active\n';
      if (file === K3S_BINARY && args[0] === 'kubectl') return (await run(TOOLS.kubectl, onTestK3s(args.slice(1)), { maxBuffer: 16 * 1024 * 1024 })).stdout;
      if (file === HELM) return (await run(TOOLS.helm, onTestK3s(args), { maxBuffer: 16 * 1024 * 1024 })).stdout;
      throw new Error(`this machine runs no ${file} in this test`);
    },
  };
}

interface Root {
  url: string;
  placed: PlacedKoala;
  heard: MachineProgress[];
  poolAsked: string[];
  close(): Promise<void>;
}

async function listening(app: express.Express): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer(app);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const DESK: PlacingMachine & { meshIp: string } = { id: 'desk', name: 'desk', meshIp: '100.64.0.7' };

async function rootWithAMovingKoala(db: MongoDB, installId: string): Promise<Root> {
  const poolAsked: string[] = [];
  const pool = express();
  pool.get(/.*/, (req: Request, res: Response) => {
    poolAsked.push(`${req.path} ${String(req.headers[MOVE_TOKEN_HEADER])}`);
    res.type('text/plain').send(keysEnv(POOL_KEYS));
  });
  const poolServer = await listening(pool);
  const poolKubeconfig = `apiVersion: v1\nkind: Config\nclusters: [{ name: pool, cluster: { server: "${poolServer.url}" } }]\ncontexts: [{ name: pool, context: { cluster: pool, user: pool } }]\ncurrent-context: pool\nusers: [{ name: pool, user: { token: pool-token } }]\n`;
  const app = express();
  app.use(express.json());
  const root = await listening(app);
  const instances = new InstanceService(db, {
    rootUrl: root.url, rootPublicKeys: () => ['PEM'], meshLoginServer: 'https://mesh.test', registry: '100.64.0.1:5001', imageTag: 'v1', domain: '',
    reach: new InstanceReach({ open: true, domain: '' }),
    moves: { joinCode: async () => { throw new Error('this test places the move directly'); }, poolClusterId: (name) => `pool-${name}` },
  }, { createPreAuthKey: async () => ({ key: 'k' }), removeNode: async () => undefined }, () => new Date(), () => undefined, {
    start: async () => undefined, trialChanged: async () => undefined, remove: async () => undefined, move: async () => undefined,
  });
  const now = new Date().toISOString();
  await db.instances.saveInstance({
    id: INSTANCE, ownerId: 'bo', url: 'https://bobby.pool.test', createdAt: now, updatedAt: now, status: 'ready', name: 'bobby',
    pool: { ports: { backend: 35000, edge: 35001, registry: 35002 }, startedAt: now, trialEndsAt: now },
  });
  await db.machines.saveLocalAgentDevice({ id: DESK.id, ownerId: 'bo', name: DESK.name, rootDir: '/home/bo/koala', createdAt: now, tokenHash: deviceTokenHash(DEVICE_TOKEN), meshIp: DESK.meshIp });
  const placing = await instances.placeOn('bo', DESK, 'bobby', installId, true);
  if (!placing.ok) throw new Error(placing.error);
  const placed = await instances.placedKoala(installId, DESK);
  if (!placed.ok) throw new Error(placed.error);
  const heard: MachineProgress[] = [];
  const installs = new KoalaInstalls({
    devices: () => db.machines.getLocalAgentDevices(),
    places: () => instances,
    workflows: {
      start: async () => undefined,
      progress: async (_installId, progress) => { heard.push(progress); },
      setup: async () => undefined,
      reconnected: async () => undefined,
      cancel: async () => undefined,
    },
    toMachines: { placeKoala: async () => true },
    toOwner: { installChanged: () => undefined },
  });
  app.use('/api/machines', machinesRouter({ installs, bundle: { path: async () => '/nowhere', sha256: async () => 'ab'.repeat(32) } }));
  app.use('/api/instances', instancesRouter({
    instances,
    chart: async () => chartFile,
    operatorOnly: (_req: Request, _res: Response, next: NextFunction) => next(),
    moveRelay: new MoveRelay({ kubeconfig: async () => poolKubeconfig, sign: (instanceId, part) => `signed-${instanceId}-${part}`, request: http.request as unknown as typeof https.request }),
  }));
  return {
    url: root.url, placed: placed.value, heard, poolAsked,
    close: async () => {
      await new Promise<void>((done) => { root.server.close(() => done()); });
      await new Promise<void>((done) => { poolServer.server.close(() => done()); });
    },
  };
}

const installing = async (placed: PlacedKoala): Promise<string[]> => {
  const said: string[] = [];
  await installKoala(placed, { cluster: thisMachine(), helm: HELM, fetch, token: () => DEVICE_TOKEN, say: (line) => said.push(line) });
  return said;
};

const stages = (heard: MachineProgress[]) => heard.filter((body) => body.line === undefined).map((body) => [body.stage, body.state, body.url].filter(Boolean).join(' '));
const secretData = async (): Promise<Record<string, string>> => {
  const secret = JSON.parse(await kubectl('get', 'secret', `${KOALA_RELEASE}-keys`, '-n', KOALA_NAMESPACE, '-o', 'json')) as { data: Record<string, string> };
  return Object.fromEntries(Object.entries(secret.data).map(([name, value]) => [name, Buffer.from(value, 'base64').toString()]));
};

let db: MongoDB;
beforeEach(async () => { db = await fresh(); });

describe('a machine brings Koala over from Koala\'s servers, its keys from root\'s real move route, on a real k3s', () => {
  it('stops at the keys, putting nothing on the cluster, when root does not know the move\'s credential, and tells root why', async () => {
    const root = await rootWithAMovingKoala(db, 'install-refused');
    try {
      const said = await installing({ ...root.placed, credential: 'not-the-move-credential' });
      expect(root.heard.at(-1)).toEqual({ stage: 'keys', title: 'Bringing your Koala\'s keys over', state: 'failed', why: 'root did not hand over your Koala\'s keys (401): {"error":"unknown instance or move credential"}' });
      expect(said.at(-1)).toBe('Bringing your Koala\'s keys over failed: root did not hand over your Koala\'s keys (401): {"error":"unknown instance or move credential"}');
      expect(root.poolAsked).toEqual([]);
      expect(await kubectl('get', 'secret', `${KOALA_RELEASE}-keys`, '-n', KOALA_NAMESPACE, '--ignore-not-found', '-o', 'name')).toBe('');
    } finally {
      await root.close();
    }
  }, 600_000);

  it('brings the pool copy\'s keys, which the chart keeps, runs the chart moving and then moved, reports each stage, and finds it all already so when asked again', async () => {
    const root = await rootWithAMovingKoala(db, 'install-move');
    try {
      const said = await installing(root.placed);
      expect(said.at(-1)).toBe('Koala runs on this machine at http://100.64.0.7:30320');
      expect(stages(root.heard)).toEqual([
        'cluster started', 'cluster already-done', 'chart started', 'chart done', 'keys started', 'keys done',
        'koala started', 'koala done', 'koala-moved started', 'koala-moved done http://100.64.0.7:30320',
      ]);
      expect(root.poolAsked).toEqual([expect.stringMatching(new RegExp(`/proxy/api/move/parts/keys signed-${INSTANCE}-keys$`))]);
      const keys = await secretData();
      for (const name of MOVED_KEYS) expect(keys[name]).toBe(POOL_KEYS[name]);
      expect(keys.TEMPORAL_KEY).toMatch(/^[A-Za-z0-9]{64}$/);
      expect(JSON.stringify([said, root.heard])).not.toContain(POOL_KEYS.SESSION_KEY);
      expect(JSON.parse(await helm('get', 'values', KOALA_RELEASE, '-n', KOALA_NAMESPACE, '--revision', '1', '-o', 'json'))).toMatchObject({ move: { enabled: true, fromClusterId: 'pool-bobby' } });
      expect(JSON.parse(await helm('get', 'values', KOALA_RELEASE, '-n', KOALA_NAMESPACE, '--revision', '2', '-o', 'json'))).not.toHaveProperty('move');
      expect(await kubectl('logs', `job/${KOALA_RELEASE}-setup-1`, '-n', KOALA_NAMESPACE)).toBe('bringing Koala over from pool-bobby\n');
      expect(await kubectl('get', 'deployment', `${KOALA_RELEASE}-backend`, '-n', KOALA_NAMESPACE, '-o', 'jsonpath={.status.availableReplicas}')).toBe('1');

      root.heard.length = 0;
      await installing(root.placed);
      expect(stages(root.heard)).toEqual([
        'cluster started', 'cluster already-done', 'chart started', 'chart done', 'keys started', 'keys already-done',
        'koala started', 'koala already-done', 'koala-moved started', 'koala-moved already-done http://100.64.0.7:30320',
      ]);
      expect(root.poolAsked).toHaveLength(1);
      expect(JSON.parse(await helm('history', KOALA_RELEASE, '-n', KOALA_NAMESPACE, '-o', 'json'))).toHaveLength(2);
    } finally {
      await root.close();
    }
  }, 600_000);
});
