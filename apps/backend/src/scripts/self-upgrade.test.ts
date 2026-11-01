import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { mountRouter, TEST_USER, type Harness } from '../platform/routes/test-harness.js';
import { instancesRouter } from '../instances/routes/instances.js';
import { InstanceService } from '../instances/services/InstanceService.js';
import { UPGRADE_WORDS, withWhy } from '../instances/index.js';
import { selfUpgrade } from './self-upgrade.js';

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

async function rootServing(chartSha256 = createHash('sha256').update(CHART).digest('hex')) {
  const chartFile = join(mkdtempSync(join(tmpdir(), 'root-chart-')), 'chart.tgz');
  writeFileSync(chartFile, CHART);
  const settings = { rootUrl: '', rootPublicKeys: () => ['PEM'], registry: 'r', imageTag: 'new222', domain: 'koala.dev', meshLoginServer: 'https://mesh.koala.dev',
    releases: { hasChart: () => false, releases: async () => [
      { imageTag: 'old111', version: 'v2026.10.29', servedAt: '2026-10-29T00:00:00Z' },
      { imageTag: 'new222', version: 'v2026.10.30', servedAt: '2026-10-30T00:00:00Z', digest: DIGEST, chartSha256 },
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

function cluster(rollouts: unknown[], refusing: string[] = []) {
  const ran: string[] = [];
  const run = async (command: string, args: readonly string[]) => {
    const line = `${command} ${args.join(' ')}`;
    ran.push(line);
    if (refusing.some((prefix) => line.startsWith(prefix))) throw new Error(`${command} ${args[0]} ended with 1: refused`);
    if (command === 'helm' && (args[0] === 'upgrade' || args[0] === 'rollback')) return '';
    if (command === 'kubectl' && args[0] === 'get') {
      const next = rollouts.shift();
      if (!next) throw new Error('the cluster was asked more often than the test expected');
      return JSON.stringify(next);
    }
    throw new Error(`the cluster was asked ${line}, which the test does not answer`);
  };
  return { run, ran };
}

const quiet = { sleep: async () => undefined, log: () => undefined };

describe('an instance upgrading itself to what root released', () => {
  it('tells root it runs what root released when it already does', async () => {
    const { root, record } = await rootServing();
    const kube = cluster([]);
    expect(await selfUpgrade({ root, release: { name: 'luno', namespace: 'nowrinkles', current: 'new222' }, run: kube.run, ...quiet })).toBe(true);
    expect(kube.ran).toEqual([]);
    expect(await record()).toMatchObject({ status: 'ready', detail: UPGRADE_WORDS.running('new222'), running: 'new222' });
  });

  it('installs root\'s chart with the image by its digest, waits for the rollout without a deadline, and says it upgraded', async () => {
    const { root, record } = await rootServing();
    const kube = cluster([rolledOut('3', STARTING, false), rolledOut('3', READY, true)]);
    expect(await selfUpgrade({ root, release: { name: 'luno', namespace: 'nowrinkles', current: 'old111' }, run: kube.run, ...quiet })).toBe(true);
    const upgrade = kube.ran.find((line) => line.startsWith('helm upgrade'))!;
    expect(upgrade).toContain('--set image.tag=new222 --set-string image.digest=' + DIGEST);
    expect(upgrade).not.toContain('--wait');
    expect(kube.ran.filter((line) => line.startsWith('kubectl get'))).toHaveLength(2);
    expect(await record()).toMatchObject({ status: 'ready', detail: UPGRADE_WORDS.upgraded('new222'), running: 'new222' });
  });

  it('rolls back the moment the new pods cannot start, and tells root why', async () => {
    const { root, record } = await rootServing();
    const kube = cluster([rolledOut('3', PULLING, false), rolledOut('4', READY, true)]);
    expect(await selfUpgrade({ root, release: { name: 'luno', namespace: 'nowrinkles', current: 'old111' }, run: kube.run, ...quiet })).toBe(false);
    expect(kube.ran.filter((line) => line.startsWith('helm')).map((line) => line.split(' ').slice(0, 2).join(' '))).toEqual(['helm upgrade', 'helm rollback']);
    expect(await record()).toMatchObject({ status: 'failed', detail: withWhy(UPGRADE_WORDS.rolledBack('new222', 'old111'), 'pod-3: ImagePullBackOff'), running: 'old111' });
  });

  it('says so when the rollback does not finish either', async () => {
    const { root, record } = await rootServing();
    const kube = cluster([rolledOut('3', PULLING, false)], ['helm rollback']);
    expect(await selfUpgrade({ root, release: { name: 'luno', namespace: 'nowrinkles', current: 'old111' }, run: kube.run, ...quiet })).toBe(false);
    expect((await record()).detail).toBe(withWhy(UPGRADE_WORDS.notRolledBack('new222', 'old111'), 'pod-3: ImagePullBackOff; rolling back: helm rollback ended with 1: refused'));
  });

  it('changes nothing when the chart root sends is not the one it released', async () => {
    const { root, record } = await rootServing('0'.repeat(64));
    const kube = cluster([]);
    expect(await selfUpgrade({ root, release: { name: 'luno', namespace: 'nowrinkles', current: 'old111' }, run: kube.run, ...quiet })).toBe(false);
    expect(kube.ran).toEqual([]);
    expect(await record()).toMatchObject({ status: 'failed', detail: UPGRADE_WORDS.wrongChart('new222') });
  });
});
