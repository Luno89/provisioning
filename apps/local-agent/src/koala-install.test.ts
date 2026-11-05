import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { createHash } from 'node:crypto';
import { K3S_KUBECONFIG, K3S_MARKER, type ClusterHost } from './machine-cluster.js';
import { helmArgs, installKoala, koalaUrlOf, placedFrom, type PlacedKoala } from './koala-install.js';

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

  it('installs the chart root released with the machine\'s own address, its id and no Docker, waiting however long it takes', () => {
    const args = helmArgs(PLACED, '/tmp/chart.tgz', '/tmp/keys.pem');
    expect(args.slice(0, 8)).toEqual(['upgrade', '--install', 'instance', '/tmp/chart.tgz', '-n', 'nowrinkles', '--create-namespace', '--kubeconfig']);
    expect(args).toContain(K3S_KUBECONFIG);
    for (const value of ['image.repository=100.64.0.1:5001/nowrinkles/app', 'image.tag=v1', 'image.digest=sha256:abc', 'instance.id=inst-1', 'instance.machineId=desk', 'instance.credential=cred', 'mesh.address=100.64.0.7', 'publicUrl=http://100.64.0.7:30320']) {
      expect(args).toContain(value);
    }
    expect(args).toContain('instance.rootPublicKeys=/tmp/keys.pem');
    expect(args.join(' ')).not.toContain('hostDocker');
    expect(args.slice(-3)).toEqual(['--wait', '--timeout', '720h']);
  });

  it('is reached at its own name under the people\'s domain when root has one', () => {
    const named = { ...PLACED, domain: 'koala.app' };
    expect(koalaUrlOf(named)).toBe('https://bobby.koala.app');
    expect(helmArgs(named, 'c', 'k')).toEqual(expect.arrayContaining(['routing.name=bobby', 'routing.domain=koala.app', 'edge.nodePort=30321']));
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

  it('installs nothing from a chart that is not the one root released, and tells root why', async () => {
    const { host, ran } = machine();
    const { fetchImpl, reports } = root(Buffer.from('something else'));
    await installKoala(PLACED, { cluster: host, helm: 'helm', fetch: fetchImpl, say: () => undefined });
    expect(ran.some(([file]) => file === 'helm')).toBe(false);
    expect(reports.at(-1)).toMatchObject({ status: 'failed', detail: 'the chart root sent is not the one it released (its sha256 differs); nothing was installed' });
  });
});
