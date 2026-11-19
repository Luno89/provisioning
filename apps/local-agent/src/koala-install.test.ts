import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { KOALA_INSTALL_PROGRESS, KOALA_MOVE_KEYS_PATH, KOALA_MOVE_PROGRESS, koalaInstallProgressPath, MOVED_FOR_LABEL } from '@koala/engine-core/koala-install';
import type { ProgressContract } from '@koala/engine-core/machine-progress';
import { progressOf } from '@koala/engine-core/machine-progress';
import { INPUTS_VALUE, SETUP_LABEL } from '@koala/provision';
import { K3S_BINARY, K3S_KUBECONFIG, K3S_MARKER, type ClusterHost, type KoalaHeld } from './machine-cluster.js';
import { installKoala, koalaPlacements, koalaUrlOf, koalaValues, placedFrom, type PlacedKoala } from './koala-install.js';

const CHART = Buffer.from('a chart');
const PLACED: PlacedKoala = {
  installId: 'install-7', instanceId: 'inst-1', ownerId: 'bo', machineId: 'desk', rootUrl: 'https://app.koala.test', rootPublicKeys: '-----BEGIN PUBLIC KEY-----',
  meshLoginServer: 'https://mesh.koala.test', meshAddress: '100.64.0.7', image: '100.64.0.1:5001/nowrinkles/app', imageTag: 'v1',
  imageDigest: 'sha256:abc', chartUrl: 'https://app.koala.test/api/instances/chart.tgz', chartSha256: createHash('sha256').update(CHART).digest('hex'),
  credential: 'cred', name: 'bobby', domain: '',
};
const HELM = '/home/bo/.local/share/koala/bin/helm';
const PROGRESS_URL = `${PLACED.rootUrl}${koalaInstallProgressPath(PLACED.installId)}`;
const KEYS_URL = `${PLACED.rootUrl}${KOALA_MOVE_KEYS_PATH}`;
const SESSION_KEY = 'c2Vzc2lvbi1rZXktb2YtdGhlLXBvb2wtY29weQ';
const DATA_KEY = 'ZGF0YS1rZXktb2YtdGhlLXBvb2wtY29weS0x';
const MOVED_KEYS = `SESSION_KEY=${SESSION_KEY}\nDATA_KEY=${DATA_KEY}\n`;
const MOVING: PlacedKoala = { ...PLACED, credential: 'move-cred', move: { fromClusterId: 'pool-bobby' } };

const rolledOut = (ready: boolean) => ({ items: [
  { kind: 'Deployment', metadata: { name: 'instance-backend', generation: 1, annotations: { 'deployment.kubernetes.io/revision': '1' } }, spec: { replicas: 1 }, status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, availableReplicas: ready ? 1 : 0 } },
  { kind: 'Job', metadata: { name: 'instance-seed-1', labels: { [SETUP_LABEL]: 'seed' } }, status: ready ? { succeeded: 1 } : { active: 1 } },
] });

interface Namespace { metadata: { name: string; labels?: Record<string, string> } }

function machine(listings: unknown[] = [rolledOut(false), rolledOut(true), rolledOut(true)], earlier: { held?: KoalaHeld; namespaces?: Namespace[]; released?: boolean } = {}) {
  const host = mock<ClusterHost>();
  const ran: string[][] = [];
  const applied: unknown[] = [];
  const values: unknown[] = [];
  let state = 'inactive';
  let release: { inputs: string } | undefined = earlier.released ? { inputs: 'an earlier move' } : undefined;
  let held = earlier.held;
  let namespaces = earlier.namespaces ?? [];
  host.exists.mockImplementation(async (path) => path === K3S_MARKER);
  host.read.mockResolvedValue('server: https://127.0.0.1:6443\n');
  host.meshIp.mockResolvedValue('100.64.0.7');
  host.now.mockReturnValue(Date.parse('2026-11-05T10:00:00Z'));
  host.holdKoala.mockImplementation(async (instanceId, installId, readyAt) => { held = { instanceId, installId, ...(readyAt ? { readyAt } : {}) }; });
  host.heldKoala.mockImplementation(async () => held);
  host.letKoalaGo.mockImplementation(async () => { held = undefined; });
  host.wanted.mockResolvedValue(undefined);
  host.run.mockImplementation(async (file, args) => {
    ran.push([file, ...args]);
    if (file === 'systemctl') return `${state}\n`;
    if (file === 'sudo' && args.includes('start')) state = 'active';
    if (file === HELM && args[0] === 'uninstall') { release = undefined; return ''; }
    if (file === K3S_BINARY && args.includes('namespaces') && args.includes('get')) return JSON.stringify({ items: namespaces });
    if (file === K3S_BINARY && args.includes('namespace') && args.includes('delete')) { namespaces = namespaces.filter((space) => !args.includes(space.metadata.name)); return ''; }
    if (file === K3S_BINARY && args.includes('clusterrolebinding')) return '';
    if (file === HELM && args[0] === 'list') return JSON.stringify(release ? [{ name: 'instance', revision: '1', status: 'deployed' }] : []);
    if (file === HELM && args[0] === 'get') return JSON.stringify(release ? { [INPUTS_VALUE]: release.inputs } : {});
    if (file === HELM && args[0] === 'upgrade') {
      release = { inputs: args.find((arg) => arg.startsWith(`${INPUTS_VALUE}=`))!.slice(INPUTS_VALUE.length + 1) };
      values.push(JSON.parse(readFileSync(args[args.indexOf('-f') + 1]!, 'utf8')));
      return '';
    }
    if (file === K3S_BINARY && args.includes('apply')) {
      applied.push(JSON.parse(readFileSync(args[args.indexOf('-f') + 1]!, 'utf8')));
      return 'namespace/nowrinkles created\nsecret/instance-keys created\n';
    }
    if (file === K3S_BINARY && args.includes('secret')) return applied.length ? 'secret/instance-keys\n' : '';
    if (file === K3S_BINARY && args.includes('jsonpath={.items[0].status.conditions[?(@.type=="Ready")].status} {.items[0].status.conditions[?(@.type=="Ready")].lastTransitionTime}')) return 'True 2026-11-05T10:00:05Z';
    if (file === K3S_BINARY && args.includes('-l')) return JSON.stringify(listings.length > 1 ? listings.shift() : listings[0]);
    return '';
  });
  return { host, ran, applied, values, held: () => held };
}

function root(chart = CHART, answer: (body: Record<string, unknown>) => Response | undefined = () => undefined, contract: ProgressContract = KOALA_INSTALL_PROGRESS, keys: () => Response = () => new Response(MOVED_KEYS)) {
  const heard: Array<{ auth: string; body: Record<string, unknown> }> = [];
  const askedForKeys: Array<Record<string, string>> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === PLACED.chartUrl) return new Response(chart);
    if (String(url) === KEYS_URL) {
      askedForKeys.push(init?.headers as Record<string, string>);
      return keys();
    }
    if (String(url) !== PROGRESS_URL) return new Response('not here', { status: 404 });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const forced = answer(body);
    if (forced) return forced;
    heard.push({ auth: (init?.headers as Record<string, string>).authorization!, body });
    const read = progressOf(body, contract);
    return read.ok ? new Response(null, { status: 204 }) : new Response(read.problem, { status: 400 });
  }) as typeof fetch;
  return { fetchImpl, heard, askedForKeys };
}

const noPause = { pause: async () => undefined };
const deps = (host: ClusterHost, fetchImpl: typeof fetch, more: Record<string, unknown> = {}) => ({ cluster: host, helm: HELM, fetch: fetchImpl, token: () => 'device-token', say: () => undefined, wait: noPause, ...more });
const said = (heard: Array<{ body: Record<string, unknown> }>) => heard.map(({ body }) => [body.stage, body.state, body.line ?? body.why ?? body.url].filter((part) => part !== undefined).join(' '));

describe('putting Koala on this machine', () => {
  it('takes only a placement that names its install and everything an install needs', () => {
    expect(placedFrom(PLACED)).toEqual(PLACED);
    expect(placedFrom({ ...PLACED, installId: '' })).toBeUndefined();
    expect(placedFrom({ ...PLACED, credential: '' })).toBeUndefined();
    expect(placedFrom('nope')).toBeUndefined();
  });

  it('gives the chart root released the machine\'s address and id and no Docker', () => {
    expect(koalaValues(PLACED)).toEqual({
      image: { repository: '100.64.0.1:5001/nowrinkles/app', tag: 'v1', digest: 'sha256:abc' },
      instance: { id: 'inst-1', ownerId: 'bo', rootUrl: 'https://app.koala.test', credential: 'cred', machineId: 'desk' },
      publicUrl: 'http://100.64.0.7:30320',
      backend: { nodePort: 30320 },
      mesh: { loginServer: 'https://mesh.koala.test', address: '100.64.0.7' },
      storage: { total: '100Gi' },
    });
    expect(JSON.stringify(koalaValues(PLACED))).not.toContain('hostDocker');
  });

  it('is reached at its own name under the people\'s domain when root has one', () => {
    const named = { ...PLACED, domain: 'koala.app' };
    expect(koalaUrlOf(named)).toBe('https://bobby.koala.app');
    expect(koalaValues(named)).toMatchObject({ publicUrl: 'https://bobby.koala.app', routing: { name: 'bobby', domain: 'koala.app' }, edge: { nodePort: 30321 } });
  });

  it('holds the cluster for Koala, starts it, applies root\'s chart with helm waiting on nothing, follows it until all is up, and tells root each stage with this machine\'s own token', async () => {
    const { host, ran } = machine();
    const { fetchImpl, heard } = root();
    await installKoala(PLACED, deps(host, fetchImpl));
    expect(host.holdKoala).toHaveBeenCalledWith('inst-1', 'install-7');
    expect(ran).toContainEqual(['sudo', '-n', 'systemctl', 'start', 'k3s']);
    const upgrade = ran.find(([file, verb]) => file === HELM && verb === 'upgrade')!;
    expect(upgrade.slice(0, 8)).toEqual([HELM, 'upgrade', '--install', 'instance', expect.stringMatching(/instance-chart\.tgz$/), '-n', 'nowrinkles', '--create-namespace']);
    expect(upgrade).not.toContain('--wait');
    expect(upgrade).not.toContain('--timeout');
    expect(said(heard)).toEqual([
      'cluster started', 'cluster started k3s answers on this machine', 'cluster done',
      'chart started', 'chart done',
      'koala started', 'koala started waiting for deployment/instance-backend has 0 of 1 available; job/instance-seed-1 runs', 'koala done http://100.64.0.7:30320',
    ]);
    expect(new Set(heard.map(({ auth }) => auth))).toEqual(new Set(['Bearer device-token']));
  });

  it('finds what is already so when asked again, and says so to root, so a repeated request is safe', async () => {
    const { host, ran } = machine([rolledOut(true)]);
    const { fetchImpl, heard } = root();
    await installKoala(PLACED, deps(host, fetchImpl));
    await installKoala(PLACED, deps(host, fetchImpl));
    expect(ran.filter(([file, verb]) => file === HELM && verb === 'upgrade')).toHaveLength(1);
    expect(said(heard).slice(-6)).toEqual(['cluster started', 'cluster already-done', 'chart started', 'chart done', 'koala started', 'koala already-done http://100.64.0.7:30320']);
  });

  it('lays the machine\'s own values for its Koala over root\'s, and tells root the address they give it', async () => {
    const { host, ran } = machine();
    host.exists.mockImplementation(async (path) => path === K3S_MARKER || path === '/home/bo/.config/koala/koala-values.yaml');
    host.read.mockImplementation(async (path) => (path.endsWith('koala-values.yaml') ? 'publicUrl: "http://127.0.0.1:3252"\n' : 'server: https://127.0.0.1:6443\n'));
    const { fetchImpl, heard } = root();
    await installKoala(PLACED, deps(host, fetchImpl, { ownValues: '/home/bo/.config/koala/koala-values.yaml' }));
    const args = ran.find(([file, verb]) => file === HELM && verb === 'upgrade') ?? [];
    const own = args.indexOf('/home/bo/.config/koala/koala-values.yaml');
    expect(args.slice(own - 3, own + 1)).toEqual(['-f', expect.stringMatching(/koala-values\.json$/), '-f', '/home/bo/.config/koala/koala-values.yaml']);
    expect(heard.at(-1)?.body).toMatchObject({ stage: 'koala', state: 'done', url: 'http://127.0.0.1:3252' });
  });

  it('installs nothing from a chart that is not the one root released, and tells root where and why it stopped', async () => {
    const { host, ran } = machine();
    const { fetchImpl, heard } = root(Buffer.from('something else'));
    await installKoala(PLACED, deps(host, fetchImpl));
    expect(ran.some(([file, verb]) => file === HELM && verb === 'upgrade')).toBe(false);
    expect(heard.at(-1)?.body).toEqual({ stage: 'chart', title: 'Fetching Koala\'s chart from root', state: 'failed', why: 'the chart root sent is not the one it released (its sha256 differs); nothing was installed' });
  });

  it('tells root once it answers again when it was restarting, and goes on', async () => {
    const { host } = machine();
    let busy = 2;
    const { fetchImpl, heard } = root(CHART, (body) => (body.stage === 'koala' && body.state === 'done' && busy-- > 0 ? new Response('restarting', { status: 503 }) : undefined));
    await installKoala(PLACED, deps(host, fetchImpl));
    expect(said(heard).at(-1)).toBe('koala done http://100.64.0.7:30320');
  });

  it('stops when root says the install it was asked for has ended, rather than going on unheard', async () => {
    const { host, ran } = machine();
    const lines: string[] = [];
    const { fetchImpl } = root(CHART, (body) => (body.stage === 'chart' ? new Response('that install has ended failed', { status: 409 }) : undefined));
    await installKoala(PLACED, deps(host, fetchImpl, { say: (line: string) => lines.push(line) }));
    expect(ran.some(([file, verb]) => file === HELM && verb === 'upgrade')).toBe(false);
    expect(lines.at(-1)).toBe('Koala could not be put on this machine: root did not take this machine\'s progress (409): that install has ended failed');
  });
});

describe('bringing Koala over from Koala\'s servers onto this machine', () => {
  const moveRoot = (keys?: () => Response) => root(CHART, () => undefined, KOALA_MOVE_PROGRESS, keys);
  const helmRuns = (ran: string[][]) => ran.filter(([file, verb]) => file === HELM && verb === 'upgrade');

  it('takes a placement that is a move only when it names the cluster Koala comes from', () => {
    expect(placedFrom(MOVING)).toEqual(MOVING);
    expect(placedFrom({ ...MOVING, move: {} })).toBeUndefined();
    expect(placedFrom({ ...MOVING, move: { fromClusterId: '' } })).toBeUndefined();
    expect(placedFrom({ ...MOVING, move: 'yes' })).toBeUndefined();
  });

  it('gives the chart the move and the cluster it comes from beside the machine\'s id, and a plain install no move', () => {
    expect(koalaValues(MOVING)).toMatchObject({ instance: { machineId: 'desk', credential: 'move-cred' }, move: { enabled: true, fromClusterId: 'pool-bobby' } });
    expect(koalaValues(PLACED)).not.toHaveProperty('move');
  });

  it('starts the cluster, fetches the chart, brings the keys over with the move\'s own credential, applies the chart moving and then moved, and tells root each stage, ending moved with where Koala answers', async () => {
    const { host, ran, applied, values } = machine([rolledOut(true)]);
    const { fetchImpl, heard, askedForKeys } = moveRoot();
    await installKoala(MOVING, deps(host, fetchImpl));
    expect(askedForKeys).toEqual([{ 'x-instance-id': 'inst-1', authorization: 'Bearer move-cred' }]);
    expect(applied).toEqual([{ apiVersion: 'v1', kind: 'List', items: [
      { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'nowrinkles' } },
      {
        apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
        metadata: { name: 'instance-keys', namespace: 'nowrinkles', labels: { 'app.kubernetes.io/managed-by': 'Helm' }, annotations: { 'meta.helm.sh/release-name': 'instance', 'meta.helm.sh/release-namespace': 'nowrinkles', 'helm.sh/resource-policy': 'keep' } },
        data: { SESSION_KEY: Buffer.from(SESSION_KEY).toString('base64'), DATA_KEY: Buffer.from(DATA_KEY).toString('base64') },
      },
    ] }]);
    expect(helmRuns(ran)).toHaveLength(2);
    expect(values[0]).toMatchObject({ move: { enabled: true, fromClusterId: 'pool-bobby' } });
    expect(values[1]).toEqual(koalaValues({ ...MOVING, move: undefined }));
    expect(said(heard)).toEqual([
      'cluster started', 'cluster started k3s answers on this machine', 'cluster done',
      'clear started', 'clear done',
      'chart started', 'chart done',
      'keys started', 'keys started your Koala\'s keys are here', 'keys done',
      'koala started', 'koala done',
      'koala-moved started', 'koala-moved done http://100.64.0.7:30320',
    ]);
    expect(new Set(heard.map(({ auth }) => auth))).toEqual(new Set(['Bearer device-token']));
  });

  it('never says or reports a key it brings over', async () => {
    const { host } = machine([rolledOut(true)]);
    const lines: string[] = [];
    const { fetchImpl, heard } = moveRoot();
    await installKoala(MOVING, deps(host, fetchImpl, { say: (line: string) => lines.push(line) }));
    const everything = JSON.stringify([lines, heard]);
    expect(lines.at(-1)).toBe('Koala runs on this machine at http://100.64.0.7:30320');
    expect(everything).not.toContain(SESSION_KEY);
    expect(everything).not.toContain(DATA_KEY);
  });

  it('asks root for the keys again while Koala\'s servers cannot be reached, and goes on', async () => {
    const { host } = machine([rolledOut(true)]);
    let busy = 2;
    const { fetchImpl, heard, askedForKeys } = moveRoot(() => (busy-- > 0 ? new Response('{"error":"Koala\'s servers could not be reached"}', { status: 502 }) : new Response(MOVED_KEYS)));
    await installKoala(MOVING, deps(host, fetchImpl));
    expect(askedForKeys).toHaveLength(3);
    expect(said(heard).at(-1)).toBe('koala-moved done http://100.64.0.7:30320');
  });

  it('stops at the keys, applying no chart, when root will not hand them over, and tells root why', async () => {
    const { host, ran } = machine([rolledOut(true)]);
    const { fetchImpl, heard } = moveRoot(() => new Response('{"error":"unknown instance or move credential"}', { status: 401 }));
    await installKoala(MOVING, deps(host, fetchImpl));
    expect(helmRuns(ran)).toHaveLength(0);
    expect(heard.at(-1)?.body).toEqual({ stage: 'keys', title: 'Bringing your Koala\'s keys over', state: 'failed', why: 'root did not hand over your Koala\'s keys (401): {"error":"unknown instance or move credential"}' });
  });

  it('stops at the keys when what root handed over are not keys, naming the line without its value', async () => {
    const { host, ran } = machine([rolledOut(true)]);
    const { fetchImpl, heard } = moveRoot(() => new Response(`SESSION_KEY=${SESSION_KEY}\nnot a key ${DATA_KEY}\n`));
    await installKoala(MOVING, deps(host, fetchImpl));
    expect(helmRuns(ran)).toHaveLength(0);
    expect(heard.at(-1)?.body).toMatchObject({ stage: 'keys', state: 'failed', why: 'root handed over keys this machine cannot read: line 2 is not NAME=value' });
    expect(JSON.stringify(heard)).not.toContain(DATA_KEY);
  });

  it('finds a finished move already so when asked again, bringing no keys and moving nothing again, and says so to root', async () => {
    const { host, ran } = machine([rolledOut(true)]);
    const { fetchImpl, heard, askedForKeys } = moveRoot();
    await installKoala(MOVING, deps(host, fetchImpl));
    await installKoala(MOVING, deps(host, fetchImpl));
    expect(askedForKeys).toHaveLength(1);
    expect(helmRuns(ran)).toHaveLength(2);
    expect(said(heard).slice(-12)).toEqual([
      'cluster started', 'cluster already-done', 'clear started', 'clear already-done', 'chart started', 'chart done',
      'keys started', 'keys already-done', 'koala started', 'koala already-done',
      'koala-moved started', 'koala-moved already-done http://100.64.0.7:30320',
    ]);
  });
});

describe('root stopping Koala on this machine, and a move starting clean', () => {
  const STOPPED_LINE = 'Putting Koala on this machine stopped: root stopped it before it finished';
  const LEFT: Namespace[] = [
    { metadata: { name: 'nowrinkles' } }, { metadata: { name: 'gitea' } }, { metadata: { name: 'pipeline-builds' } }, { metadata: { name: 'searxng' } },
    { metadata: { name: 'books', labels: { [MOVED_FOR_LABEL]: 'inst-1' } } }, { metadata: { name: 'shop' } }, { metadata: { name: 'monitoring' } },
    { metadata: { name: 'kube-system' } }, { metadata: { name: 'theirs', labels: { [MOVED_FOR_LABEL]: 'inst-9' } } },
  ];
  const removals = (ran: string[][]) => ran.filter(([file, ...args]) => (file === HELM && args[0] === 'uninstall') || (file === K3S_BINARY && args.includes('delete')));
  const REMOVED = [
    [HELM, 'uninstall', 'instance', '-n', 'nowrinkles', '--kubeconfig', K3S_KUBECONFIG],
    [K3S_BINARY, 'kubectl', '--kubeconfig', K3S_KUBECONFIG, 'delete', 'clusterrolebinding', '-l', 'app.kubernetes.io/part-of=nowrinkles-instance', '--ignore-not-found'],
    [K3S_BINARY, 'kubectl', '--kubeconfig', K3S_KUBECONFIG, 'delete', 'namespace', 'nowrinkles', 'gitea', 'pipeline-builds', 'searxng', 'books', '--ignore-not-found', '--wait=false'],
  ];

  it('stops at its next command or wait when root stops it, tells root nothing more, and says it stopped', async () => {
    const { host, ran } = machine([rolledOut(false)]);
    const stop = new AbortController();
    const lines: string[] = [];
    let at = 0;
    const { fetchImpl, heard } = root(CHART, (body) => {
      if (typeof body.line === 'string' && body.line.startsWith('waiting')) {
        stop.abort();
        at = ran.length;
      }
      return undefined;
    });
    await installKoala(PLACED, deps(host, fetchImpl, { say: (line: string) => lines.push(line) }), stop.signal);
    expect(said(heard).at(-1)).toBe('koala started waiting for deployment/instance-backend has 0 of 1 available; job/instance-seed-1 runs');
    expect(heard.some(({ body }) => body.state === 'failed')).toBe(false);
    expect(lines.at(-1)).toBe(STOPPED_LINE);
    expect(ran).toHaveLength(at);
  });

  it('starts nothing for an install root stopped before it began', async () => {
    const { host, ran } = machine();
    const stop = new AbortController();
    stop.abort();
    const lines: string[] = [];
    const { fetchImpl, heard } = root();
    await installKoala(PLACED, deps(host, fetchImpl, { say: (line: string) => lines.push(line) }), stop.signal);
    expect(ran).toEqual([]);
    expect(heard).toEqual([]);
    expect(lines.at(-1)).toBe(STOPPED_LINE);
  });

  it('on a move onto a machine an earlier move left Koala on, removes that Koala first: its release, its namespace, the platform\'s and the apps it restored, nothing else, and then holds the cluster for this move', async () => {
    const { host, ran, held } = machine([rolledOut(true)], { held: { instanceId: 'inst-1', installId: 'install-6' }, namespaces: LEFT, released: true });
    const { fetchImpl, heard } = root(CHART, () => undefined, KOALA_MOVE_PROGRESS);
    await installKoala(MOVING, deps(host, fetchImpl));
    expect(removals(ran)).toEqual(REMOVED);
    expect(said(heard).slice(3, 7)).toEqual([
      'clear started', 'clear started removing what was put on this machine for Koala before: instance, nowrinkles, gitea, pipeline-builds, searxng, books',
      'clear started nothing of that Koala is left on this machine', 'clear done',
    ]);
    expect(held()).toEqual({ instanceId: 'inst-1', installId: 'install-7', readyAt: '2026-11-05T10:00:00.000Z' });
    expect(said(heard).at(-1)).toBe('koala-moved done http://100.64.0.7:30320');
  });

  it('removes nothing on a move onto a machine that holds no earlier Koala, and holds the cluster for it', async () => {
    const { host, ran, held } = machine([rolledOut(true)], { namespaces: LEFT });
    const { fetchImpl } = root(CHART, () => undefined, KOALA_MOVE_PROGRESS);
    await installKoala(MOVING, deps(host, fetchImpl));
    expect(removals(ran)).toEqual([]);
    expect(held()).toEqual({ instanceId: 'inst-1', installId: 'install-7', readyAt: '2026-11-05T10:00:00.000Z' });
  });

  it('on a move onto a machine whose Koala ever ran, removes nothing of it and stops with why, since that Koala may hold the person\'s work', async () => {
    const earlier: KoalaHeld = { instanceId: 'inst-1', installId: 'install-6', readyAt: '2026-11-01T09:00:00.000Z' };
    const { host, ran, held } = machine([rolledOut(true)], { held: earlier, namespaces: LEFT, released: true });
    const { fetchImpl, heard } = root(CHART, () => undefined, KOALA_MOVE_PROGRESS);
    await installKoala(MOVING, deps(host, fetchImpl));
    expect(removals(ran)).toEqual([]);
    expect(ran.some(([file, verb]) => file === HELM && verb === 'upgrade')).toBe(false);
    expect(said(heard).slice(3)).toEqual([
      'clear started',
      'clear failed desk already runs a Koala of yours, from its install install-6, ready since 2026-11-01T09:00:00.000Z; it may hold your work, so the move removed nothing of it. Move onto another machine instead',
    ]);
    expect(held()).toEqual(earlier);
  });

  it('on a move onto a machine holding a Koala from before installs were noted ready, takes that Koala as one that ran and removes nothing of it', async () => {
    const { host, ran, held } = machine([rolledOut(true)], { held: { instanceId: 'inst-1' }, namespaces: LEFT, released: true });
    const { fetchImpl, heard } = root(CHART, () => undefined, KOALA_MOVE_PROGRESS);
    await installKoala(MOVING, deps(host, fetchImpl));
    expect(removals(ran)).toEqual([]);
    expect(said(heard).at(-1)).toBe('clear failed desk already runs a Koala of yours, from an install made before this machine noted when its Koala was ready; it may hold your work, so the move removed nothing of it. Move onto another machine instead');
    expect(held()).toEqual({ instanceId: 'inst-1' });
  });

  it('notes on the machine when its Koala is ready, before root hears it, and keeps that note when the same install is asked again', async () => {
    const { host, held } = machine([rolledOut(true)]);
    const noted: Array<KoalaHeld | undefined> = [];
    const { fetchImpl } = root(CHART, (body) => {
      if (body.stage === 'koala' && body.state === 'done') noted.push(held());
      return undefined;
    });
    await installKoala(PLACED, deps(host, fetchImpl));
    await installKoala(PLACED, deps(host, fetchImpl));
    expect(noted).toEqual([{ instanceId: 'inst-1', installId: 'install-7', readyAt: '2026-11-05T10:00:00.000Z' }]);
    expect(held()).toEqual({ instanceId: 'inst-1', installId: 'install-7', readyAt: '2026-11-05T10:00:00.000Z' });
    expect(host.holdKoala.mock.calls.filter((call) => call[2] === undefined)).toHaveLength(1);
  });

  it('stops a move under way when root says so, then removes what that move made and lets the cluster go', async () => {
    const { host, ran, held } = machine([rolledOut(true)], { namespaces: LEFT.slice(4) });
    const lines: string[] = [];
    let stopped: Promise<void> | undefined;
    const placements = koalaPlacements(deps(host, root(CHART, (body) => {
      if (body.stage === 'keys' && body.state === 'started') stopped = placements.stop({ installId: 'install-7', remove: true });
      return undefined;
    }, KOALA_MOVE_PROGRESS).fetchImpl, { say: (line: string) => lines.push(line) }));
    expect(placements.place(MOVING)).toBe(true);
    while (!stopped) await new Promise((done) => setImmediate(done));
    await stopped;
    expect(ran.some(([file, verb]) => file === HELM && verb === 'upgrade')).toBe(false);
    expect(removals(ran)).toEqual([
      REMOVED[1],
      [K3S_BINARY, 'kubectl', '--kubeconfig', K3S_KUBECONFIG, 'delete', 'namespace', 'books', '--ignore-not-found', '--wait=false'],
    ]);
    expect(held()).toBeUndefined();
    expect(lines).toContain('Moving Koala here stopped: root stopped it before it finished');
    expect(lines.at(-1)).toBe('nothing of the stopped move is left on this machine');
  });

  it('removes nothing when root stops an install that put nothing here, or that this machine holds for another install, and only stops one it does not ask to remove from', async () => {
    const { host, ran, held } = machine([rolledOut(true)], { held: { instanceId: 'inst-1', installId: 'install-9' }, namespaces: LEFT, released: true });
    const placements = koalaPlacements(deps(host, root().fetchImpl));
    await placements.stop({ installId: 'install-7', remove: true });
    await placements.stop({ installId: 'install-9', remove: false });
    await placements.stop('not a stop');
    expect(removals(ran)).toEqual([]);
    expect(held()).toEqual({ instanceId: 'inst-1', installId: 'install-9' });
  });

  it('removes nothing when root stops an install whose Koala reached ready, and says why', async () => {
    const ready: KoalaHeld = { instanceId: 'inst-1', installId: 'install-9', readyAt: '2026-11-01T09:00:00.000Z' };
    const { host, ran, held } = machine([rolledOut(true)], { held: ready, namespaces: LEFT, released: true });
    const lines: string[] = [];
    const placements = koalaPlacements(deps(host, root().fetchImpl, { say: (line: string) => lines.push(line) }));
    await placements.stop({ installId: 'install-9', remove: true });
    expect(removals(ran)).toEqual([]);
    expect(held()).toEqual(ready);
    expect(lines.at(-1)).toBe('root asked to remove the Koala of install install-9, but it was ready since 2026-11-01T09:00:00.000Z and may hold your work, so nothing of it was removed');
  });

  it('stops the install it runs for a Koala when root places that Koala again under a newer install', async () => {
    const { host } = machine([rolledOut(false)]);
    const lines: string[] = [];
    let newer: Promise<void> | undefined;
    const placements = koalaPlacements(deps(host, root(CHART, (body) => {
      if (!newer && typeof body.line === 'string' && body.line.startsWith('waiting')) {
        placements.place({ ...PLACED, installId: 'install-8' });
        newer = placements.stop({ installId: 'install-8', remove: false });
      }
      return undefined;
    }).fetchImpl, { say: (line: string) => lines.push(line) }));
    placements.place(PLACED);
    while (!newer) await new Promise((done) => setImmediate(done));
    await newer;
    expect(lines.filter((line) => line === STOPPED_LINE)).toHaveLength(2);
  });
});
