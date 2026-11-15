import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { createHash } from 'node:crypto';
import { reopening } from '@koala/engine-core/reopening';
import { K3S_KUBECONFIG, K3S_MARKER, type ClusterHost } from './machine-cluster.js';
import { helmArgs, installKoala, koalaUrlOf, koalaValues, placedFrom, type PlacedKoala } from './koala-install.js';

const CHART = Buffer.from('a chart');
const PLACED: PlacedKoala = {
  instanceId: 'inst-1', ownerId: 'bo', machineId: 'desk', rootUrl: 'https://app.koala.test', rootPublicKeys: '-----BEGIN PUBLIC KEY-----',
  meshLoginServer: 'https://mesh.koala.test', meshAddress: '100.64.0.7', image: '100.64.0.1:5001/nowrinkles/app', imageTag: 'v1',
  imageDigest: 'sha256:abc', chartUrl: 'https://app.koala.test/api/instances/chart.tgz', chartSha256: createHash('sha256').update(CHART).digest('hex'),
  credential: 'cred', name: 'bobby', domain: '',
};

function machine() {
  const host = mock<ClusterHost>();
  const ran: string[][] = [];
  let state = 'inactive';
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
    if (args[0] === 'kubectl') return 'True 2026-11-05T10:00:05Z';
    return '';
  });
  return { host, ran };
}

function root(chart = CHART) {
  const reports: Array<{ status: string; detail: string; url?: string; imageTag?: string; meshIp?: string; presence?: boolean }> = [];
  const headers: Array<Record<string, string>> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === PLACED.chartUrl) return new Response(chart);
    headers.push(init?.headers as Record<string, string>);
    reports.push(JSON.parse(String(init?.body)) as never);
    return new Response(null, { status: 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, reports, headers };
}

describe('putting Koala on this machine', () => {
  it('takes only a placement that names everything an install needs', () => {
    expect(placedFrom(PLACED)).toEqual(PLACED);
    expect(placedFrom({ ...PLACED, credential: '' })).toBeUndefined();
    expect(placedFrom('nope')).toBeUndefined();
  });

  it('installs the chart root released with the machine\'s address and id and no Docker, its values in files the machine\'s own come after, waiting however long it takes', () => {
    expect(koalaValues(PLACED)).toEqual({
      image: { repository: '100.64.0.1:5001/nowrinkles/app', tag: 'v1', digest: 'sha256:abc' },
      instance: { id: 'inst-1', ownerId: 'bo', rootUrl: 'https://app.koala.test', credential: 'cred', machineId: 'desk' },
      publicUrl: 'http://100.64.0.7:30320',
      backend: { nodePort: 30320 },
      mesh: { loginServer: 'https://mesh.koala.test', address: '100.64.0.7' },
      storage: { total: '100Gi' },
    });
    expect(JSON.stringify(koalaValues(PLACED))).not.toContain('hostDocker');
    expect(helmArgs('/tmp/chart.tgz', ['/tmp/koala.json', '/home/bo/own.yaml'], '/tmp/keys.pem')).toEqual([
      'upgrade', '--install', 'instance', '/tmp/chart.tgz', '-n', 'nowrinkles', '--create-namespace', '--kubeconfig', K3S_KUBECONFIG,
      '-f', '/tmp/koala.json', '-f', '/home/bo/own.yaml', '--set-file', 'instance.rootPublicKeys=/tmp/keys.pem', '--wait', '--timeout', '720h',
    ]);
  });

  it('is reached at its own name under the people\'s domain when root has one', () => {
    const named = { ...PLACED, domain: 'koala.app' };
    expect(koalaUrlOf(named)).toBe('https://bobby.koala.app');
    expect(koalaValues(named)).toMatchObject({ publicUrl: 'https://bobby.koala.app', routing: { name: 'bobby', domain: 'koala.app' }, edge: { nodePort: 30321 } });
  });

  it('holds the machine\'s cluster for Koala, starts it, installs, and tells root each step with the instance\'s credential', async () => {
    const { host, ran } = machine();
    const { fetchImpl, reports, headers } = root();
    await installKoala(PLACED, { cluster: host, helm: '/home/bo/.local/share/koala/bin/helm', fetch: fetchImpl, say: () => undefined });
    expect(host.holdKoala).toHaveBeenCalledWith('inst-1');
    expect(ran).toContainEqual(['sudo', '-n', 'systemctl', 'start', 'k3s']);
    expect(ran.find(([file]) => file === '/home/bo/.local/share/koala/bin/helm')?.[1]).toBe('upgrade');
    expect(reports.map((report) => report.status)).toEqual(['installing', 'installing', 'ready']);
    expect(reports.at(-1)).toMatchObject({ url: 'http://100.64.0.7:30320', imageTag: 'v1', meshIp: '100.64.0.7', presence: true });
    expect(headers[0]).toMatchObject({ 'x-instance-id': 'inst-1', authorization: 'Bearer cred' });
  });

  it('lays the machine\'s own values for its Koala over root\'s, when it keeps any', async () => {
    const { host, ran } = machine();
    host.exists.mockImplementation(async (path) => path === K3S_MARKER || path === '/home/bo/.config/koala/koala-values.yaml');
    host.read.mockImplementation(async (path) => (path.endsWith('koala-values.yaml') ? 'dev:\n  source: /x\n' : 'server: https://127.0.0.1:6443\n'));
    const { fetchImpl } = root();
    await installKoala(PLACED, { cluster: host, helm: 'helm', fetch: fetchImpl, say: () => undefined, ownValues: '/home/bo/.config/koala/koala-values.yaml' });
    const args = ran.find(([file]) => file === 'helm') ?? [];
    expect(args.slice(args.indexOf('/home/bo/.config/koala/koala-values.yaml') - 3, args.indexOf('/home/bo/.config/koala/koala-values.yaml') + 1)).toEqual(['-f', expect.stringMatching(/koala-values\.json$/), '-f', '/home/bo/.config/koala/koala-values.yaml']);
  });

  it('tells root the address the machine\'s own values give Koala from the first report on', async () => {
    const { host } = machine();
    host.exists.mockImplementation(async (path) => path === K3S_MARKER || path === '/home/bo/own.yaml');
    host.read.mockImplementation(async (path) => (path === '/home/bo/own.yaml' ? 'publicUrl: "http://127.0.0.1:3252"\n' : 'server: https://127.0.0.1:6443\n'));
    const { fetchImpl, reports } = root();
    await installKoala(PLACED, { cluster: host, helm: 'helm', fetch: fetchImpl, say: () => undefined, ownValues: '/home/bo/own.yaml' });
    expect(reports.map((report) => report.url)).toEqual(['http://127.0.0.1:3252', 'http://127.0.0.1:3252', 'http://127.0.0.1:3252']);
  });

  it('installs nothing from a chart that is not the one root released, and tells root why', async () => {
    const { host, ran } = machine();
    const { fetchImpl, reports } = root(Buffer.from('something else'));
    await installKoala(PLACED, { cluster: host, helm: 'helm', fetch: fetchImpl, say: () => undefined });
    expect(ran.some(([file]) => file === 'helm')).toBe(false);
    expect(reports.at(-1)).toMatchObject({ status: 'failed', detail: 'the chart root sent is not the one it released (its sha256 differs); nothing was installed' });
  });
  it('tells root Koala is ready once root answers again, when root was restarting as the install finished', async () => {
    const { host } = machine();
    const { fetchImpl, reports } = root();
    let refusals = 2;
    const restarting = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) !== PLACED.chartUrl && String(init?.body).includes('"ready"') && refusals-- > 0) {
        throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
      }
      return fetchImpl(url, init);
    }) as typeof fetch;
    await installKoala(PLACED, { cluster: host, helm: 'helm', fetch: restarting, say: () => undefined, wait: reopening(1) });
    expect(reports.map((report) => report.status)).toEqual(['installing', 'installing', 'ready']);
  });

  it('tells root once it answers again when it answered that it is busy', async () => {
    const { host } = machine();
    const { fetchImpl, reports } = root();
    let busy = 1;
    const answering = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) !== PLACED.chartUrl && String(init?.body).includes('"ready"') && busy-- > 0) return new Response('restarting', { status: 503 });
      return fetchImpl(url, init);
    }) as typeof fetch;
    await installKoala(PLACED, { cluster: host, helm: 'helm', fetch: answering, say: () => undefined, wait: reopening(1) });
    expect(reports.map((report) => report.status)).toEqual(['installing', 'installing', 'ready']);
  });
});
