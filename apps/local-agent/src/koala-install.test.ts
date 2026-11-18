import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { createHash } from 'node:crypto';
import { KOALA_INSTALL_PROGRESS, koalaInstallProgressPath } from '@koala/engine-core/koala-install';
import { progressOf } from '@koala/engine-core/machine-progress';
import { INPUTS_VALUE, SETUP_LABEL } from '@koala/provision';
import { K3S_BINARY, K3S_KUBECONFIG, K3S_MARKER, type ClusterHost } from './machine-cluster.js';
import { installKoala, koalaUrlOf, koalaValues, machineChartCluster, placedFrom, type PlacedKoala } from './koala-install.js';

const CHART = Buffer.from('a chart');
const PLACED: PlacedKoala = {
  installId: 'install-7', instanceId: 'inst-1', ownerId: 'bo', machineId: 'desk', rootUrl: 'https://app.koala.test', rootPublicKeys: '-----BEGIN PUBLIC KEY-----',
  meshLoginServer: 'https://mesh.koala.test', meshAddress: '100.64.0.7', image: '100.64.0.1:5001/nowrinkles/app', imageTag: 'v1',
  imageDigest: 'sha256:abc', chartUrl: 'https://app.koala.test/api/instances/chart.tgz', chartSha256: createHash('sha256').update(CHART).digest('hex'),
  credential: 'cred', name: 'bobby', domain: '',
};
const HELM = '/home/bo/.local/share/koala/bin/helm';
const PROGRESS_URL = `${PLACED.rootUrl}${koalaInstallProgressPath(PLACED.installId)}`;

const rolledOut = (ready: boolean) => ({ items: [
  { kind: 'Deployment', metadata: { name: 'instance-backend', generation: 1, annotations: { 'deployment.kubernetes.io/revision': '1' } }, spec: { replicas: 1 }, status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, availableReplicas: ready ? 1 : 0 } },
  { kind: 'Job', metadata: { name: 'instance-seed-1', labels: { [SETUP_LABEL]: 'seed' } }, status: ready ? { succeeded: 1 } : { active: 1 } },
] });

function machine(listings: unknown[] = [rolledOut(false), rolledOut(true), rolledOut(true)]) {
  const host = mock<ClusterHost>();
  const ran: string[][] = [];
  let state = 'inactive';
  let release: { inputs: string } | undefined;
  host.exists.mockImplementation(async (path) => path === K3S_MARKER);
  host.read.mockResolvedValue('server: https://127.0.0.1:6443\n');
  host.meshIp.mockResolvedValue('100.64.0.7');
  host.now.mockReturnValue(Date.parse('2026-11-05T10:00:00Z'));
  host.holdKoala.mockResolvedValue(undefined);
  host.wanted.mockResolvedValue(undefined);
  host.run.mockImplementation(async (file, args) => {
    ran.push([file, ...args]);
    if (file === 'systemctl') return `${state}\n`;
    if (file === 'sudo' && args.includes('start')) state = 'active';
    if (file === HELM && args[0] === 'list') return JSON.stringify(release ? [{ name: 'instance', revision: '1', status: 'deployed' }] : []);
    if (file === HELM && args[0] === 'get') return JSON.stringify(release ? { [INPUTS_VALUE]: release.inputs } : {});
    if (file === HELM && args[0] === 'upgrade') {
      release = { inputs: args.find((arg) => arg.startsWith(`${INPUTS_VALUE}=`))!.slice(INPUTS_VALUE.length + 1) };
      return '';
    }
    if (file === K3S_BINARY && args.includes('jsonpath={.items[0].status.conditions[?(@.type=="Ready")].status} {.items[0].status.conditions[?(@.type=="Ready")].lastTransitionTime}')) return 'True 2026-11-05T10:00:05Z';
    if (file === K3S_BINARY && args.includes('-l')) return JSON.stringify(listings.length > 1 ? listings.shift() : listings[0]);
    return '';
  });
  return { host, ran };
}

function root(chart = CHART, answer: (body: Record<string, unknown>) => Response | undefined = () => undefined) {
  const heard: Array<{ auth: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === PLACED.chartUrl) return new Response(chart);
    if (String(url) !== PROGRESS_URL) return new Response('not here', { status: 404 });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const forced = answer(body);
    if (forced) return forced;
    heard.push({ auth: (init?.headers as Record<string, string>).authorization!, body });
    const read = progressOf(body, KOALA_INSTALL_PROGRESS);
    return read.ok ? new Response(null, { status: 204 }) : new Response(read.problem, { status: 400 });
  }) as typeof fetch;
  return { fetchImpl, heard };
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

  it('reaches this machine\'s k3s with helm and kubectl through its own kubeconfig', async () => {
    const { host, ran } = machine();
    const cluster = machineChartCluster(host, HELM);
    await cluster.helm(['list', '-n', 'nowrinkles']);
    await cluster.kubectl(['get', 'pods']);
    expect(ran).toEqual([[HELM, 'list', '-n', 'nowrinkles', '--kubeconfig', K3S_KUBECONFIG], [K3S_BINARY, 'kubectl', '--kubeconfig', K3S_KUBECONFIG, 'get', 'pods']]);
  });

  it('holds the cluster for Koala, starts it, applies root\'s chart with helm waiting on nothing, follows it until all is up, and tells root each stage with this machine\'s own token', async () => {
    const { host, ran } = machine();
    const { fetchImpl, heard } = root();
    await installKoala(PLACED, deps(host, fetchImpl));
    expect(host.holdKoala).toHaveBeenCalledWith('inst-1');
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
