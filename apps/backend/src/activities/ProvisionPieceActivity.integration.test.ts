import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeProcesses, nodeStreams } from '../platform/index.js';
import { emptiedEachTime } from '../platform/lib/test-database.js';
import { ClusterAccess, InfrastructureService, openedRecord, terraformPlacesFor, type ProvisionPieceInput } from '../infrastructure/index.js';
import { privateCluster, type PrivateCluster } from '../infrastructure/testing/private-cluster.js';
import { CLUSTER_TOOL_PATHS } from '../infrastructure/index.js';
import { testDataDir } from '../platform/testing/data-dir.js';
import { CannotRollOut } from './watched-apply.js';
import type { ClusterSteps } from './cluster-steps.js';
import { ProvisionPieceActivity, recordedLines, type ProvisionPlace } from './ProvisionPieceActivity.js';

const ALL_BUT_JOBS = ['', 'apps', 'networking.k8s.io', 'rbac.authorization.k8s.io', 'policy', 'admissionregistration.k8s.io', 'apiextensions.k8s.io', 'coordination.k8s.io', 'autoscaling', 'discovery.k8s.io', 'storage.k8s.io', 'scheduling.k8s.io', 'events.k8s.io'];
const fresh = await emptiedEachTime();
const quickly = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, Math.min(ms, 500)); });

let k3s: PrivateCluster;
let steps: Pick<ClusterSteps, 'access' | 'infra' | 'database' | 'machineMetricsUrl'>;
let place: ProvisionPlace;

beforeAll(async () => {
  k3s = await privateCluster(import.meta.filename);
  const access = new ClusterAccess({
    here: { koalaMachineId: 'desk', root: false },
    folder: mkdtempSync(join(tmpdir(), 'koala-provision-piece-')),
    processes: nodeProcesses, streams: nodeStreams, tools: CLUSTER_TOOL_PATHS, serviceAccount: k3s.account,
  });
  const dataDir = testDataDir();
  mkdirSync(dataDir, { recursive: true });
  place = { koalaNamespace: 'nowrinkles', pool: false, dataDir, crawl4aiToken: 'crawlToken40' };
  steps = {
    access,
    infra: new InfrastructureService(terraformPlacesFor({ kind: 'local' }, dataDir)),
    database: { mongo: { uri: 'mongodb://unused', dbName: 'unused' }, dataKey: 'unused' },
    machineMetricsUrl: { off: 'this test sets up no other machine' },
  };
}, 0);

afterAll(async () => { await k3s?.stop(); }, 0);

async function opened(runId: string) {
  const db = await fresh();
  const record = openedRecord({ ownerId: 'owner-1', target: { kind: 'koala', clusterId: 'machine-desk' }, revision: 1, reason: 'revision', runId, at: '2026-11-18T09:00:00.000Z' });
  await db.infrastructure.openProvisioning(record);
  const input = (piece: ProvisionPieceInput['piece']): ProvisionPieceInput => ({ ownerId: 'owner-1', recordId: runId, target: record.target, revision: 1, piece });
  return { store: db.infrastructure, input };
}

async function accessReadingNoJobs(): Promise<ClusterAccess> {
  const { access } = steps;
  const own = access.own();
  await access.apply(own, JSON.stringify({
    apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: 'reads-no-jobs' },
    rules: [{ apiGroups: ALL_BUT_JOBS, resources: ['*'], verbs: ['*'] }, { nonResourceURLs: ['*'], verbs: ['get'] }],
  }));
  await access.kubectl(own, ['create', 'serviceaccount', 'piece', '-n', 'default']);
  await access.kubectl(own, ['create', 'clusterrolebinding', 'piece', '--clusterrole=reads-no-jobs', '--serviceaccount=default:piece']);
  const folder = mkdtempSync(join(tmpdir(), 'koala-piece-account-'));
  copyFileSync(k3s.account.caFile, join(folder, 'ca.crt'));
  writeFileSync(join(folder, 'token'), (await access.kubectl(own, ['create', 'token', 'piece', '-n', 'default', '--duration=1h'])).trim(), { mode: 0o600 });
  return new ClusterAccess({
    here: { koalaMachineId: 'desk', root: false },
    folder: mkdtempSync(join(tmpdir(), 'koala-provision-piece-')),
    processes: nodeProcesses, streams: nodeStreams, tools: CLUSTER_TOOL_PATHS, serviceAccount: { ...k3s.account, caFile: join(folder, 'ca.crt'), tokenFile: join(folder, 'token') },
  });
}

describe('one piece of a Koala\'s setup, applied on a real cluster and kept on its record in a real Mongo', () => {
  it('says once that what it applies cannot be read while that lasts, and brings the piece up once it can', async () => {
    const { store, input } = await opened('provision-machine-desk~unread');
    const access = await accessReadingNoJobs();
    const said: string[] = [];
    let granted: Promise<string> | undefined;
    const lines = recordedLines(store);
    const heard: typeof lines = {
      async heard(given, change) {
        if (change.state === 'started' && change.line) said.push(change.line);
        if (!granted && change.state === 'started' && change.line?.includes('could not be read')) granted = steps.access.kubectl(steps.access.own(), ['create', 'clusterrolebinding', 'piece-jobs', '--clusterrole=cluster-admin', '--serviceaccount=default:piece']);
        await lines.heard(given, change);
      },
    };

    await ProvisionPieceActivity(input('egress'), { steps: { ...steps, access }, place, lines: heard }, quickly);
    await granted;

    const unread = said.filter((line) => line.startsWith('what the egress proxy made could not be read while it applies: '));
    expect(unread, said.join('\n')).toHaveLength(1);
    expect(unread[0]).toMatch(/jobs.* is forbidden/);
    expect(said).toContain('the egress proxy: ready');
  }, 0);

  it('brings the egress proxy up, its record saying what the apply said while it worked', async () => {
    const { store, input } = await opened('provision-machine-desk~egress');

    await ProvisionPieceActivity(input('egress'), { steps, place, lines: recordedLines(store) }, quickly);

    const egress = (await store.getProvisioningRun('provision-machine-desk~egress'))?.pieces.find((piece) => piece.key === 'egress');
    expect(egress).toMatchObject({ state: 'working', line: 'the egress proxy: ready' });
    expect(await steps.access.kubectl(steps.access.own(), ['get', 'deployment', 'egress-proxy', '-n', 'koala-egress', '-o', 'jsonpath={.status.availableReplicas}'])).toBe('1');
  }, 0);

  it('fails with the workload and why once a service can never start, its record keeping the last line it said', async () => {
    const { store, input } = await opened('provision-machine-desk~searxng');
    await steps.access.kubectl(steps.access.own(), ['create', 'namespace', 'searxng']);
    await steps.access.kubectl(steps.access.own(), ['create', 'quota', 'none', '-n', 'searxng', '--hard=pods=0']);

    const failed = await ProvisionPieceActivity(input('searxng'), { steps, place, lines: recordedLines(store) }, quickly).then(() => undefined, (err: unknown) => err);

    expect(failed, `the piece ended otherwise: ${String((failed as Error | undefined)?.message ?? failed)}`).toBeInstanceOf(CannotRollOut);
    expect((failed as CannotRollOut).why).toMatch(/^searxng cannot make its pods: .*exceeded quota/);
    const searxng = (await store.getProvisioningRun('provision-machine-desk~searxng'))?.pieces.find((piece) => piece.key === 'searxng');
    expect(searxng).toMatchObject({ state: 'working', line: expect.stringMatching(/^SearXNG/) as unknown });
  }, 0);
});
