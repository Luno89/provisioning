import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { afterAll, afterEach, describe, expect, inject, it } from 'vitest';
import { nodeProcesses, nodeStreams } from '../platform/index.js';
import { ClusterAccess } from '../infrastructure/services/ClusterAccess.js';
import { TOOLS } from '../infrastructure/testing/real-k3s.js';
import { testNamespaces } from '../infrastructure/testing/test-namespaces.js';
import { mountRouter, TEST_USER, type Harness } from '../platform/routes/test-harness.js';
import { instancesRouter } from '../instances/routes/instances.js';
import { InstanceService } from '../instances/services/InstanceService.js';
import { UPGRADE_WORDS, withWhy } from '../instances/index.js';
import { selfUpgrade, selfUpgradeStep } from './self-upgrade.js';
import { reopening } from '@koala/engine-core/reopening';
import { INPUTS_VALUE, SETUP_LABEL } from '@koala/provision';
import { koalaPlacedAndUp } from '../instances/testing/placed-koala.js';

const CHART = 'the chart root released';
const DIGEST = `sha256:${'e'.repeat(64)}`;

const rolledOut = (revision: string, container: Record<string, unknown>, done: boolean) => ({ items: [
  { kind: 'Deployment', metadata: { name: 'luno-backend', generation: 2, annotations: { 'deployment.kubernetes.io/revision': revision } }, spec: { replicas: 1 }, status: { observedGeneration: 2, replicas: 1, updatedReplicas: done ? 1 : 0, availableReplicas: done ? 1 : 0 } },
  { kind: 'ReplicaSet', metadata: { name: `rs-${revision}`, annotations: { 'deployment.kubernetes.io/revision': revision }, ownerReferences: [{ kind: 'Deployment', name: 'luno-backend' }] } },
  { kind: 'Pod', metadata: { name: `pod-${revision}`, ownerReferences: [{ kind: 'ReplicaSet', name: `rs-${revision}` }] }, status: { phase: 'Running', containerStatuses: [{ name: 'backend', ...container }] } },
] });
const READY = { ready: true, state: { running: {} } };
const STARTING = { ready: false, state: { waiting: { reason: 'ContainerCreating' } } };
const PULLING = { ready: false, state: { waiting: { reason: 'ImagePullBackOff' } } };

let harness: Harness | undefined;
afterEach(async () => { await harness?.close(); harness = undefined; });

async function rootServing(given?: string, newData?: number, chart: string | Buffer = CHART) {
  const chartSha256 = given ?? createHash('sha256').update(chart).digest('hex');
  const chartFile = join(mkdtempSync(join(tmpdir(), 'root-chart-')), 'chart.tgz');
  writeFileSync(chartFile, chart);
  const settings = { rootUrl: '', rootPublicKeys: () => ['PEM'], registry: 'r', imageTag: 'new222', domain: 'koala.dev', meshLoginServer: 'https://mesh.koala.dev',
    releases: { hasChart: () => false, releases: async () => [
      { imageTag: 'old111', version: 'v2026.10.29', servedAt: '2026-10-29T00:00:00Z' },
      { imageTag: 'new222', version: 'v2026.10.30', servedAt: '2026-10-30T00:00:00Z', digest: DIGEST, chartSha256, ...(newData ? { dataVersion: newData } : {}) },
    ] } };
  let service: InstanceService | undefined;
  harness = await mountRouter({
    prefix: '/api/instances',
    router: (db) => {
      service = new InstanceService(db, settings, { createPreAuthKey: async () => ({ key: 'k' }), listUserDevices: async () => [{ ipAddresses: ['100.64.0.9'] }] });
      return instancesRouter({ instances: service, chart: async () => chartFile, operatorOnly: (_req: Request, _res: Response, next: NextFunction) => next() });
    },
  });
  settings.rootUrl = harness.url('');
  const joined = { value: await koalaPlacedAndUp(service!, harness.db, TEST_USER.id, { id: 'box', name: 'box', meshIp: '100.64.0.9' }, 'luno') };
  const ran = await service!.report(joined.value.instanceId, joined.value.credential, { status: 'ready', detail: 'Installed', imageTag: 'old111', presence: true });
  if (!ran.ok) throw new Error(ran.error);
  return {
    root: { url: harness.url(''), instanceId: joined.value.instanceId, credential: joined.value.credential },
    record: async () => (await harness!.db.instances.getInstances()).find((entry) => entry.id === joined.value.instanceId)!,
    setUp: async (revision: number, progress: Record<string, string> = { stage: 'set-up', title: 'Koala is set up', state: 'done' }) => {
      const heard = await service!.report(joined.value.instanceId, joined.value.credential, { provision: { revision, progress } });
      if (!heard.ok) throw new Error(heard.error);
    },
  };
}


function cluster(rollouts: unknown[], refusing: string[] = [], logs = '') {
  const ran: string[] = [];
  let inputs = 'what old111 was installed from';
  const run = async (command: string, args: readonly string[]) => {
    const line = `${command} ${args.join(' ')}`;
    ran.push(line);
    if (refusing.some((prefix) => line.startsWith(prefix))) throw new Error(`${command} ${args[0]} ended with 1: refused`);
    if (command === 'helm' && args[0] === 'list') return JSON.stringify([{ name: 'luno', revision: '3', status: 'deployed' }]);
    if (command === 'helm' && args[0] === 'get') return JSON.stringify({ [INPUTS_VALUE]: inputs });
    if (command === 'helm' && args[0] === 'upgrade') {
      inputs = args.find((arg) => arg.startsWith(`${INPUTS_VALUE}=`))!.slice(INPUTS_VALUE.length + 1);
      return '';
    }
    if (command === 'helm' && args[0] === 'rollback') return '';
    if (command === 'kubectl' && args[0] === 'logs') return logs;
    if (command === 'kubectl' && args[0] === 'get') {
      const next = rollouts.shift();
      if (!next) throw new Error('the cluster was asked more often than the test expected');
      return JSON.stringify(next);
    }
    throw new Error(`the cluster was asked ${line}, which the test does not answer`);
  };
  return { cluster: { kubectl: (args: readonly string[]) => run('kubectl', args), helm: (args: readonly string[]) => run('helm', args) }, ran };
}

const setupJob = (status: Record<string, unknown>) => ({ kind: 'Job', metadata: { name: 'luno-seed-4', labels: { [SETUP_LABEL]: 'seed' } }, status });
const withJob = (listed: { items: unknown[] }, job: unknown, ...more: unknown[]) => ({ items: [...listed.items, job, ...more] });
const helmRan = (ran: string[]) => ran.filter((line) => /^helm (upgrade|rollback)/.test(line)).map((line) => line.split(' ').slice(0, 2).join(' '));
const UPGRADING = UPGRADE_WORDS.upgrading('old111', 'new222');

const quiet = { watch: { pause: async () => undefined }, log: () => undefined };

describe('an instance upgrading itself to what root released', () => {
  it('tells root it runs what root released when it already does, ready only once the revision it runs is set up, and never over a piece that failed', async () => {
    const { root, record, setUp } = await rootServing();
    const kube = cluster([]);
    const run = () => selfUpgrade({ root, release: { name: 'luno', namespace: 'nowrinkles', current: 'new222', dataVersion: 0 }, cluster: kube.cluster, ...quiet });
    expect(await run()).toBe(true);
    expect(kube.ran).toEqual(['helm list -n nowrinkles --filter ^luno$ -a -o json']);
    expect(await record()).toMatchObject({ status: 'installing', detail: UPGRADE_WORDS.running('new222'), running: 'new222' });
    await setUp(3, { stage: 'gitea', title: 'Gitea', state: 'failed', why: 'pod gitea-0 is Init:Error' });
    expect(await run()).toBe(true);
    expect(await record()).toMatchObject({ status: 'failed', detail: 'Koala on box stopped setting itself up at Gitea: pod gitea-0 is Init:Error' });
    await setUp(3);
    expect(await run()).toBe(true);
    expect(await record()).toMatchObject({ status: 'ready', detail: UPGRADE_WORDS.running('new222'), running: 'new222' });
  });

  it('waits for a root that is not answering, saying so each time, and checks in once it answers', async () => {
    const { root, record, setUp } = await rootServing();
    await setUp(3);
    const kube = cluster([]);
    const said: string[] = [];
    let refused = 2;
    const closed = await new Promise<number>((done) => { const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address() as AddressInfo; server.close(() => done(port)); }); });
    const rootDown: typeof fetch = (url, init) => (refused-- > 0 ? fetch(`http://127.0.0.1:${closed}/`, init) : fetch(url, init));
    expect(await selfUpgrade({ root, release: { name: 'luno', namespace: 'nowrinkles', current: 'new222', dataVersion: 0 }, cluster: kube.cluster, fetch: rootDown, wait: reopening(1), log: (line) => said.push(line) })).toBe(true);
    expect(said).toEqual([
      'root isn\'t answering when this instance asks which release to run (it refused the connection (ECONNREFUSED)); asking again in 0 s',
      'root isn\'t answering when this instance asks which release to run (it refused the connection (ECONNREFUSED)); asking again in 0 s',
    ]);
    expect(await record()).toMatchObject({ status: 'ready', detail: UPGRADE_WORDS.running('new222'), running: 'new222' });
  });

  it('applies root\'s chart with the image by its digest, helm waiting on nothing, follows the rollout and its setup Jobs without a deadline, and says it upgraded, leaving ready to the new revision\'s setup', async () => {
    const { root, record, setUp } = await rootServing();
    await setUp(2);
    const said: string[] = [];
    const kube = cluster([
      withJob(rolledOut('3', STARTING, false), setupJob({ active: 1 })),
      withJob(rolledOut('3', READY, true), setupJob({ active: 1 })),
      withJob(rolledOut('3', READY, true), setupJob({ succeeded: 1 })),
      withJob(rolledOut('3', READY, true), setupJob({ succeeded: 1 })),
    ]);
    expect(await selfUpgrade({ root, release: { name: 'luno', namespace: 'nowrinkles', current: 'old111', dataVersion: 0 }, cluster: kube.cluster, watch: quiet.watch, log: (line) => said.push(line) })).toBe(true);
    const upgrade = kube.ran.find((line) => line.startsWith('helm upgrade'))!;
    expect(upgrade).toContain('--set image.tag=new222 --set-string image.digest=' + DIGEST);
    expect(upgrade).not.toMatch(/--wait|--timeout/);
    expect(said).toEqual(['waiting for deployment/luno-backend has 0 of 1 updated; job/luno-seed-4 runs', 'waiting for job/luno-seed-4 runs']);
    expect(await record()).toMatchObject({ status: 'installing', detail: UPGRADE_WORDS.upgraded('new222'), running: 'new222' });
    await setUp(3);
    expect(await record()).toMatchObject({ status: 'ready', detail: 'Ready', running: 'new222' });
  });

  it('tells root the data version it runs each time it checks in', async () => {
    const { root, record } = await rootServing();
    await selfUpgrade({ root, release: { name: 'luno', namespace: 'nowrinkles', current: 'new222', dataVersion: 1 }, cluster: cluster([]).cluster, ...quiet });
    expect(await record()).toMatchObject({ running: 'new222', dataVersion: 1 });
  });

  it('refuses a release that cannot run the data it has, changing nothing', async () => {
    const { root, record } = await rootServing();
    const kube = cluster([]);
    expect(await selfUpgrade({ root, release: { name: 'luno', namespace: 'nowrinkles', current: 'old111', dataVersion: 1 }, cluster: kube.cluster, ...quiet })).toBe(false);
    expect(kube.ran).toEqual([]);
    expect(await record()).toMatchObject({ status: 'failed', detail: UPGRADE_WORDS.belowData('new222', 1), running: 'old111' });
  });

  it('does not roll back a failed upgrade that moved the data forward, since the release before cannot run it', async () => {
    const { root, record } = await rootServing(undefined, 1);
    const kube = cluster([rolledOut('3', PULLING, false)]);
    expect(await selfUpgrade({ root, release: { name: 'luno', namespace: 'nowrinkles', current: 'old111', dataVersion: 0 }, cluster: kube.cluster, ...quiet })).toBe(false);
    expect(helmRan(kube.ran)).toEqual(['helm upgrade']);
    expect(await record()).toMatchObject({ status: 'failed', detail: withWhy(UPGRADE_WORDS.keptForData('new222', 'old111', 1), `${UPGRADING}: pod-3: ImagePullBackOff`), dataVersion: 1 });
  });

  it('rolls back the moment the new pods cannot start, follows the rollback until it is up, and tells root why', async () => {
    const { root, record } = await rootServing();
    const kube = cluster([rolledOut('3', PULLING, false), rolledOut('4', STARTING, false), rolledOut('4', READY, true)]);
    expect(await selfUpgrade({ root, release: { name: 'luno', namespace: 'nowrinkles', current: 'old111', dataVersion: 0 }, cluster: kube.cluster, ...quiet })).toBe(false);
    expect(helmRan(kube.ran)).toEqual(['helm upgrade', 'helm rollback']);
    expect(kube.ran.find((line) => line.startsWith('helm rollback'))).toBe('helm rollback luno -n nowrinkles');
    expect(await record()).toMatchObject({ status: 'failed', detail: withWhy(UPGRADE_WORDS.rolledBack('new222', 'old111'), `${UPGRADING}: pod-3: ImagePullBackOff`), running: 'old111' });
  });

  it('says so when the rollback does not finish either', async () => {
    const { root, record } = await rootServing();
    const kube = cluster([rolledOut('3', PULLING, false)], ['helm rollback']);
    expect(await selfUpgrade({ root, release: { name: 'luno', namespace: 'nowrinkles', current: 'old111', dataVersion: 0 }, cluster: kube.cluster, ...quiet })).toBe(false);
    expect((await record()).detail).toBe(withWhy(UPGRADE_WORDS.notRolledBack('new222', 'old111'), `${UPGRADING}: pod-3: ImagePullBackOff; rolling back: helm rollback ended with 1: refused`));
  });

  it('rolls back when a setup Job of the new release fails, saying which and why, with the end of its log', async () => {
    const { root, record } = await rootServing();
    const failed = setupJob({ failed: 1, conditions: [{ type: 'Failed', status: 'True', message: 'Job has reached the specified backoff limit' }] });
    const kube = cluster([withJob(rolledOut('3', READY, true), failed), rolledOut('4', READY, true)], [], 'seeding\nMongoServerError: not primary\n');
    expect(await selfUpgrade({ root, release: { name: 'luno', namespace: 'nowrinkles', current: 'old111', dataVersion: 0 }, cluster: kube.cluster, ...quiet })).toBe(false);
    expect(helmRan(kube.ran)).toEqual(['helm upgrade', 'helm rollback']);
    expect((await record()).detail).toBe(withWhy(UPGRADE_WORDS.rolledBack('new222', 'old111'), `${UPGRADING}: job/luno-seed-4 failed: Job has reached the specified backoff limit\nthe end of its log:\nseeding\nMongoServerError: not primary`));
  });

  it('changes nothing when the chart root sends is not the one it released', async () => {
    const { root, record } = await rootServing('0'.repeat(64));
    const kube = cluster([]);
    expect(await selfUpgrade({ root, release: { name: 'luno', namespace: 'nowrinkles', current: 'old111', dataVersion: 0 }, cluster: kube.cluster, ...quiet })).toBe(false);
    expect(kube.ran).toEqual([]);
    expect(await record()).toMatchObject({ status: 'failed', detail: UPGRADE_WORDS.wrongChart('new222') });
  });
});

const k3s = inject('k3s');
const namespaces = testNamespaces(k3s.admin);
afterAll(async () => { await namespaces.removeAll(); }, 0);

function imageChart(): string {
  const chart = mkdtempSync(join(tmpdir(), 'koala-upgrade-chart-'));
  mkdirSync(join(chart, 'templates'));
  writeFileSync(join(chart, 'Chart.yaml'), 'apiVersion: v2\nname: luno\nversion: 0.1.0\n');
  writeFileSync(join(chart, 'values.yaml'), 'image:\n  tag: "1.37"\n  digest: ""\n');
  writeFileSync(join(chart, 'templates', 'backend.yaml'), [
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata:',
    '  name: {{ .Release.Name }}-backend',
    '  labels: { app.kubernetes.io/instance: {{ .Release.Name }} }',
    'spec:',
    '  replicas: 1',
    '  selector: { matchLabels: { app.kubernetes.io/instance: {{ .Release.Name }} } }',
    '  template:',
    '    metadata: { labels: { app.kubernetes.io/instance: {{ .Release.Name }} } }',
    '    spec:',
    '      terminationGracePeriodSeconds: 0',
    '      containers: [{ name: backend, image: "busybox:{{ .Values.image.tag }}", command: [sleep, "100000"] }]',
    '',
  ].join('\n'));
  return chart;
}

describe('an instance upgrading itself as its CronJob runs it, on a real k3s', () => {
  it('rolls the release back to what it ran when root\'s release can never start, and tells root why', async () => {
    const namespace = namespaces.name('self-upgrade');
    const admin = new ClusterAccess({ here: { root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-self-upgrade-')), processes: nodeProcesses, streams: nodeStreams, tools: TOOLS });
    const desk = { clusterId: 'desk', kind: 'machine' as const, kubeconfig: k3s.admin };
    const chart = imageChart();
    await admin.kubectl(desk, ['create', 'namespace', namespace]);
    await admin.helm(desk, ['upgrade', '--install', 'luno', chart, '-n', namespace]);
    const packed = mkdtempSync(join(tmpdir(), 'koala-upgrade-packed-'));
    await admin.packageChart(chart, packed);
    const { root, record } = await rootServing(undefined, undefined, readFileSync(join(packed, 'luno-0.1.0.tgz')));
    const said: string[] = [];

    const upgraded = await selfUpgradeStep({
      ROLE: 'instance', INSTANCE_ID: root.instanceId, INSTANCE_OWNER_ID: TEST_USER.id, ROOT_URL: root.url,
      ROOT_PUBLIC_KEYS: Buffer.from(String(generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }))).toString('base64'),
      INSTANCE_MACHINE_ID: 'desk', INSTANCE_CREDENTIAL: root.credential, RELEASE_NAME: 'luno', RELEASE_NAMESPACE: namespace, CURRENT_IMAGE_TAG: 'old111', DATA_VERSION: '0',
      KUBERNETES_SERVICE_HOST: k3s.account.host, KUBERNETES_SERVICE_PORT: k3s.account.port,
    }, dirname(k3s.account.caFile), (line) => said.push(line));

    expect(upgraded, said.join('\n')).toBe(false);
    expect((await record()).detail).toMatch(new RegExp(`^${withWhy(UPGRADE_WORDS.rolledBack('new222', 'old111'), UPGRADING).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: .*(ErrImagePull|ImagePullBackOff)`));
    expect(await admin.kubectl(desk, ['get', 'deployment', 'luno-backend', '-n', namespace, '-o', 'jsonpath={.spec.template.spec.containers[0].image}'])).toBe('busybox:1.37');
  }, 0);
});

