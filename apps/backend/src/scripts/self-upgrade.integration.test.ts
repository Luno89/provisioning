import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { mountRouter, TEST_USER, type Harness } from '../platform/routes/test-harness.js';
import { instancesRouter } from '../instances/routes/instances.js';
import { InstanceService } from '../instances/services/InstanceService.js';
import { UPGRADE_WORDS, withWhy } from '../instances/index.js';
import { selfUpgrade } from './self-upgrade.js';
import { reopening } from '@koala/engine-core/reopening';
import { INPUTS_VALUE, SETUP_LABEL } from '@koala/provision';

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

async function rootServing(chartSha256 = createHash('sha256').update(CHART).digest('hex'), newData?: number) {
  const chartFile = join(mkdtempSync(join(tmpdir(), 'root-chart-')), 'chart.tgz');
  writeFileSync(chartFile, CHART);
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
  const made = await service!.createJoinToken(TEST_USER.id, 'luno');
  if (!made.ok) throw new Error(made.error);
  const joined = await service!.join(made.value.token, 'box');
  if (!joined.ok) throw new Error(joined.error);
  const ran = await service!.report(joined.value.instanceId, joined.value.credential, { status: 'ready', detail: 'Installed', imageTag: 'old111', presence: true });
  if (!ran.ok) throw new Error(ran.error);
  return {
    root: { url: harness.url(''), instanceId: joined.value.instanceId, credential: joined.value.credential },
    record: async () => (await harness!.db.instances.getInstances()).find((entry) => entry.id === joined.value.instanceId)!,
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
  it('tells root it runs what root released when it already does', async () => {
    const { root, record } = await rootServing();
    const kube = cluster([]);
    expect(await selfUpgrade({ root, release: { name: 'luno', namespace: 'nowrinkles', current: 'new222', dataVersion: 0 }, cluster: kube.cluster, ...quiet })).toBe(true);
    expect(kube.ran).toEqual([]);
    expect(await record()).toMatchObject({ status: 'ready', detail: UPGRADE_WORDS.running('new222'), running: 'new222' });
  });

  it('waits for a root that is not answering, saying so each time, and checks in once it answers', async () => {
    const { root, record } = await rootServing();
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

  it('applies root\'s chart with the image by its digest, helm waiting on nothing, follows the rollout and its setup Jobs without a deadline, and says it upgraded', async () => {
    const { root, record } = await rootServing();
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
    expect(await record()).toMatchObject({ status: 'ready', detail: UPGRADE_WORDS.upgraded('new222'), running: 'new222' });
  });

  it('tells root the data version it runs each time it checks in', async () => {
    const { root, record } = await rootServing();
    await selfUpgrade({ root, release: { name: 'luno', namespace: 'nowrinkles', current: 'new222', dataVersion: 1 }, cluster: cluster([]).cluster, ...quiet });
    expect(await record()).toMatchObject({ status: 'ready', running: 'new222', dataVersion: 1 });
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
