import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

const mockReaddir = vi.fn();
const mockWriteFile = vi.fn();
const mockMkdir = vi.fn();
const mockUnlink = vi.fn();

vi.mock('node:fs/promises', () => ({
  default: {
    mkdir: mockMkdir,
    writeFile: mockWriteFile,
    readdir: mockReaddir,
    unlink: mockUnlink,
  },
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
  readdir: mockReaddir,
  unlink: mockUnlink,
}));

const mockExec = vi.fn((cmd: string, cb: Function) => cb(null, { stdout: '', stderr: '' }));
const mockSpawnStdoutOn = vi.fn();
const mockSpawnStderrOn = vi.fn();
const mockSpawnOn = vi.fn();
const mockSpawn = vi.fn(() => ({
  stdout: { on: mockSpawnStdoutOn },
  stderr: { on: mockSpawnStderrOn },
  on: mockSpawnOn,
  kill: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  exec: mockExec,
  spawn: mockSpawn,
}));

vi.mock('node:util', () => ({
  promisify: (fn: Function) => {
    return (...args: any[]) => Promise.resolve({ stdout: '', stderr: '' });
  },
}));

vi.mock('node:url', () => ({
  fileURLToPath: () => '/app/src/services/AppExposureService.ts',
}));

const mockGetDeployments = vi.fn();
const mockSaveDeployment = vi.fn();
const mockGetById = vi.fn();
const mockGetKubeconfigPath = vi.fn();
const mockRunKubectl = vi.fn();
const mockGetK3dServerIp = vi.fn();

let AppExposureService: any;

beforeAll(async () => {
  const mod = await import('./AppExposureService.js');
  AppExposureService = mod.AppExposureService;
});

function createService() {
  const db = { getDeployments: mockGetDeployments, saveDeployment: mockSaveDeployment };
  const infra = { runKubectl: mockRunKubectl, getK3dServerIp: mockGetK3dServerIp };
  const clusters = {
    getById: mockGetById,
    getByIdUnscoped: mockGetById,
    getKubeconfigPath: mockGetKubeconfigPath,
  };
  return new AppExposureService(db, infra, clusters);
}

beforeEach(() => {
  vi.clearAllMocks();
});

const traefikSvcJson = JSON.stringify({ spec: { type: 'NodePort', ports: [{ name: 'web', port: 80, nodePort: 32080 }] } });

describe('sanitize', () => {
  it('converts to lowercase and replaces non-alphanumeric chars with hyphens', () => {
    expect((createService() as any).sanitize('Hello World-Foo!')).toBe('hello-world-foo');
  });
  it('removes leading and trailing hyphens', () => {
    expect((createService() as any).sanitize('--hello--')).toBe('hello');
  });
  it('collapses multiple hyphens', () => {
    expect((createService() as any).sanitize('a---b---c')).toBe('a-b-c');
  });
});

describe('buildConfContent', () => {
  it('generates a valid nginx server block', () => {
    const content = (createService() as any).buildConfContent('my-app', '172.17.0.1:31301', 'my-app.apps.local');
    expect(content).toContain('server {');
    expect(content).toContain('server_name my-app ~^my-app\\..*$;');
    expect(content).toContain('set $upstream "172.17.0.1:31301";');
    expect(content).toContain('proxy_set_header Host my-app.apps.local;');
  });
  it('handles namespaces with hyphens', () => {
    const content = (createService() as any).buildConfContent('my-long-app-name', '10.0.0.1:8080', 'my-long-app-name.apps.local');
    expect(content).toContain('server_name my-long-app-name ~^my-long-app-name\\..*$;');
  });
});

describe('syncExposedApps', () => {
  const mockCluster = { id: 'c1', name: 'Tc', provider: 'k3d' as const, status: 'healthy' as const };
  const mockDep = { id: 'd1', name: 'MyApp', clusterId: 'c1', strategy: 'native' as const, status: 'running' as const, isExposed: true, isExposedPublicly: true, publicExposureUrl: 'http://x' };
  const svcJson = JSON.stringify({ items: [{ metadata: { name: 'm-web' }, spec: { type: 'NodePort', ports: [{ port: 80, nodePort: 31301 }] } }] });

  it('writes conf.d and removes stale configs', async () => {
    process.env.INGRESS_DOMAIN = 'nowrinkles.dev';
    mockGetDeployments.mockResolvedValue([mockDep]);
    mockGetById.mockResolvedValue(mockCluster);
    mockGetKubeconfigPath.mockResolvedValue('/tmp/kubeconfig');
    mockRunKubectl.mockResolvedValueOnce(svcJson).mockResolvedValueOnce(traefikSvcJson);
    mockGetK3dServerIp.mockResolvedValue('10.0.0.5');
    mockReaddir.mockResolvedValue(['default.conf', 'myapp.conf', 'old.conf']);

    const svc = createService();
    await svc.syncExposedApps();

    expect(mockRunKubectl).toHaveBeenCalledWith(['get', 'svc', '-n', 'myapp', '-o', 'json'], '/tmp/kubeconfig');
    expect(mockWriteFile).toHaveBeenCalledOnce();
    expect(mockUnlink).toHaveBeenCalled();
    delete process.env.INGRESS_DOMAIN;
  });

  it('removes stale configs when no deployments exposed', async () => {
    mockGetDeployments.mockResolvedValue([{ ...mockDep, isExposed: false, isExposedPublicly: false, isExposedLocally: false }]);
    mockReaddir.mockResolvedValue(['default.conf', 'myapp.conf', 'stale.conf']);

    await createService().syncExposedApps();
    expect(mockUnlink).toHaveBeenCalledTimes(2);
  });

  it('preserves default.conf', async () => {
    mockGetDeployments.mockResolvedValue([]);
    mockReaddir.mockResolvedValue(['default.conf', 'stale-app.conf']);

    await createService().syncExposedApps();
    expect(mockUnlink).toHaveBeenCalledOnce();
    expect(mockUnlink.mock.calls[0]![0]).toContain('stale-app.conf');
  });

  it('handles missing cluster gracefully', async () => {
    mockGetDeployments.mockResolvedValue([mockDep]);
    mockGetById.mockResolvedValue(null);

    await createService().syncExposedApps();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('handles kubectl errors gracefully', async () => {
    mockGetDeployments.mockResolvedValue([mockDep]);
    mockGetById.mockResolvedValue(mockCluster);
    mockGetKubeconfigPath.mockResolvedValue('/tmp/kubeconfig');
    mockRunKubectl.mockRejectedValue(new Error('err'));
    mockReaddir.mockResolvedValue(['default.conf']);

    await createService().syncExposedApps();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('does nothing when no deployments exist', async () => {
    mockGetDeployments.mockResolvedValue([]);
    mockReaddir.mockResolvedValue(['default.conf']);

    await createService().syncExposedApps();
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockUnlink).not.toHaveBeenCalled();
    expect(mockExec).not.toHaveBeenCalled();
  });
});

describe('buildUpstreamTarget', () => {
  const cluster = { id: 'c1', name: 'Tc', provider: 'k3d' as const, status: 'healthy' as const };
  const dep = { id: 'd1', name: 'MyApp', clusterId: 'c1', strategy: 'native' as const, status: 'running' as const };

  it('builds target for k3d using NodePort', async () => {
    mockGetKubeconfigPath.mockResolvedValue('/tmp/k');
    mockRunKubectl.mockResolvedValueOnce(JSON.stringify({ items: [{ metadata: { name: 'm-w' }, spec: { type: 'NodePort', ports: [{ port: 80, nodePort: 31301 }] } }] })).mockResolvedValueOnce(traefikSvcJson);
    mockGetK3dServerIp.mockResolvedValue('10.0.0.5');
    const r = await (createService() as any).buildUpstreamTarget(dep, cluster);
    expect(r).toEqual({ namespace: 'myapp', backendTarget: '10.0.0.5:32080', appHostname: 'myapp.apps.local' });
  });

  it('prefers web over DB services', async () => {
    mockGetKubeconfigPath.mockResolvedValue('/tmp/k');
    mockRunKubectl.mockResolvedValueOnce(JSON.stringify({ items: [
      { metadata: { name: 'm-pg' }, spec: { ports: [{ port: 5432 }] } },
      { metadata: { name: 'm-w' }, spec: { type: 'NodePort', ports: [{ port: 80, nodePort: 31301 }] } },
    ] })).mockResolvedValueOnce(traefikSvcJson);
    mockGetK3dServerIp.mockResolvedValue('10.0.0.5');
    const r = await (createService() as any).buildUpstreamTarget(dep, cluster);
    expect(r.backendTarget).toBe('10.0.0.5:32080');
  });

  it('throws when no web services', async () => {
    mockGetKubeconfigPath.mockResolvedValue('/tmp/k');
    mockRunKubectl.mockResolvedValue(JSON.stringify({ items: [] }));
    await expect((createService() as any).buildUpstreamTarget(dep, cluster)).rejects.toThrow('No proxyable web services');
  });

  it('throws when Traefik has no NodePort assigned', async () => {
    mockGetKubeconfigPath.mockResolvedValue('/tmp/k');
    mockRunKubectl
      .mockResolvedValueOnce(JSON.stringify({ items: [{ metadata: { name: 'm-w' }, spec: { type: 'NodePort', ports: [{ port: 80, nodePort: 31301 }] } }] }))
      .mockResolvedValueOnce(JSON.stringify({ spec: { type: 'ClusterIP', ports: [{ name: 'web', port: 80 }] } }));
    await expect((createService() as any).buildUpstreamTarget(dep, cluster)).rejects.toThrow('does not have a nodePort');
  });
});

describe('unexposePublic / unexposeLocal', () => {
  it('unexposePublic removes conf.d when local exposure is not also active', async () => {
    mockGetDeployments.mockResolvedValue([{ id: 'd1', name: 'MyApp', clusterId: 'c1', strategy: 'native' as const, status: 'running' as const, isExposed: true, isExposedPublicly: true, publicExposureUrl: 'https://myapp-d1.nowrinkles.dev' }]);
    mockSaveDeployment.mockResolvedValue(undefined);

    const result = await createService().unexposePublic('d1');

    expect(mockUnlink).toHaveBeenCalled();
    const saved = mockSaveDeployment.mock.calls[0]![0];
    expect(saved.isExposed).toBe(false);
    expect(saved.isExposedPublicly).toBe(false);
    expect(saved.publicExposureUrl).toBeUndefined();
    expect(saved.exposureUrl).toBeUndefined();
    expect(result.isExposed).toBe(false);
  });

  it('unexposePublic removes only the Caddy site, leaving local exposure alone', async () => {
    mockGetDeployments.mockResolvedValue([{ id: 'd1', name: 'MyApp', clusterId: 'c1', strategy: 'native' as const, status: 'running' as const, isExposed: true, isExposedPublicly: true, publicExposureUrl: 'https://myapp-d1.nowrinkles.dev', isExposedLocally: true, localExposureUrl: 'http://myapp.localhost:8000' }]);
    mockGetById.mockResolvedValue({ id: 'c1', name: 'Tc', provider: 'k3d' as const, status: 'healthy' as const });
    mockGetKubeconfigPath.mockResolvedValue('/tmp/k');
    mockRunKubectl.mockResolvedValueOnce(JSON.stringify({ items: [{ metadata: { name: 'm-w' }, spec: { type: 'NodePort', ports: [{ port: 80, nodePort: 31301 }] } }] })).mockResolvedValueOnce(traefikSvcJson);
    mockGetK3dServerIp.mockResolvedValue('10.0.0.5');
    mockSaveDeployment.mockResolvedValue(undefined);

    const result = await createService().unexposePublic('d1');

    expect(mockUnlink).toHaveBeenCalledOnce();
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(result.isExposed).toBe(true);
    expect(result.isExposedLocally).toBe(true);
    expect(result.exposureUrl).toBe('http://myapp.localhost:8000');
  });

  it('unexposeLocal removes conf.d when public exposure is not also active', async () => {
    mockGetDeployments.mockResolvedValue([{ id: 'd1', name: 'MyApp', clusterId: 'c1', strategy: 'native' as const, status: 'running' as const, isExposed: true, isExposedLocally: true, localExposureUrl: 'http://myapp.localhost:8000' }]);
    mockSaveDeployment.mockResolvedValue(undefined);

    const result = await createService().unexposeLocal('d1');

    expect(mockUnlink).toHaveBeenCalled();
    const saved = mockSaveDeployment.mock.calls[0]![0];
    expect(saved.isExposed).toBe(false);
    expect(saved.isExposedLocally).toBe(false);
    expect(result.isExposed).toBe(false);
  });
});

describe('exposePublic / exposeLocal', () => {
  it('exposePublic writes a Caddy site and returns the platform URL', async () => {
    mockGetDeployments.mockResolvedValue([{ id: 'd1', name: 'MyApp', clusterId: 'c1', strategy: 'native' as const, status: 'running' as const }]);
    mockGetById.mockResolvedValue({ id: 'c1', name: 'Tc', provider: 'k3d' as const, status: 'healthy' as const });
    mockGetKubeconfigPath.mockResolvedValue('/tmp/k');
    mockRunKubectl.mockResolvedValueOnce(JSON.stringify({ items: [{ metadata: { name: 'm-w' }, spec: { type: 'NodePort', ports: [{ port: 80, nodePort: 31301 }] } }] })).mockResolvedValueOnce(traefikSvcJson);
    mockGetK3dServerIp.mockResolvedValue('10.0.0.5');
    mockSaveDeployment.mockResolvedValue(undefined);
    process.env.INGRESS_DOMAIN = 'nowrinkles.dev';

    const result = await createService().exposePublic('d1');

    expect(mockWriteFile).toHaveBeenCalledOnce();
    expect(result.isExposedPublicly).toBe(true);
    expect(result.exposureUrl).toMatch(/^https:\/\/myapp-[a-z0-9]+\.nowrinkles\.dev$/);
    delete process.env.INGRESS_DOMAIN;
  });

  it('exposePublic refuses when there is no public domain to serve from', async () => {
    mockGetDeployments.mockResolvedValue([{ id: 'd1', name: 'MyApp', clusterId: 'c1', strategy: 'native' as const, status: 'running' as const }]);
    mockGetById.mockResolvedValue({ id: 'c1', name: 'Tc', provider: 'k3d' as const, status: 'healthy' as const });
    delete process.env.INGRESS_DOMAIN;
    await expect(createService().exposePublic('d1')).rejects.toThrow(/INGRESS_DOMAIN/);
  });

  it('exposeLocal writes conf.d without starting a tunnel', async () => {
    mockGetDeployments.mockResolvedValue([{ id: 'd1', name: 'MyApp', clusterId: 'c1', strategy: 'native' as const, status: 'running' as const }]);
    mockGetById.mockResolvedValue({ id: 'c1', name: 'Tc', provider: 'k3d' as const, status: 'healthy' as const });
    mockGetKubeconfigPath.mockResolvedValue('/tmp/k');
    mockRunKubectl.mockResolvedValueOnce(JSON.stringify({ items: [{ metadata: { name: 'm-w' }, spec: { type: 'NodePort', ports: [{ port: 80, nodePort: 31301 }] } }] })).mockResolvedValueOnce(traefikSvcJson);
    mockGetK3dServerIp.mockResolvedValue('10.0.0.5');
    mockSaveDeployment.mockResolvedValue(undefined);

    const result = await createService().exposeLocal('d1');

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockWriteFile).toHaveBeenCalledOnce();
    expect(result.isExposed).toBe(true);
    expect(result.isExposedLocally).toBe(true);
    expect(result.exposureUrl).toBe('http://myapp.localhost:8000');
  });

  it('throws when not found', async () => {
    mockGetDeployments.mockResolvedValue([]);
    await expect(createService().exposePublic('x')).rejects.toThrow('Deployment not found');
    await expect(createService().exposeLocal('x')).rejects.toThrow('Deployment not found');
  });
});

describe('buildUpstreamTarget on mesh clusters', () => {
  const appSvcJson = JSON.stringify({ items: [{ metadata: { name: 'web' }, spec: { ports: [{ port: 80 }] } }] });

  const target = async (cluster: any) => {
    mockGetKubeconfigPath.mockResolvedValue('/tmp/kubeconfig-test');
    mockRunKubectl.mockResolvedValueOnce(appSvcJson).mockResolvedValueOnce(traefikSvcJson);
    return (createService() as any).buildUpstreamTarget({ name: 'my-app' }, cluster);
  };

  it('routes to the mesh IP and Traefik nodePort', async () => {
    const r = await target({ name: 'hz', provider: 'hetzner', meshIp: '100.64.0.5' });
    expect(r.backendTarget).toBe('100.64.0.5:32080');
    expect(r.appHostname).toBe('my-app.apps.local');
  });

  it('works the same for a bring-your-own machine', async () => {
    const r = await target({ name: 'gpu-box', provider: 'remote', meshIp: '100.64.0.9' });
    expect(r.backendTarget).toBe('100.64.0.9:32080');
  });

  it('blames the missing mesh address, not a load balancer, for a self-managed cluster', async () => {
    await expect(target({ name: 'hz', provider: 'hetzner' })).rejects.toThrow(/no mesh address/);
  });

});

describe('public hostname allocation', () => {
  const svc = () => createService() as any;

  it('is stable across calls, so a saved link keeps working', () => {
    const dep = { id: 'abc123de-0000-4000-8000-000000000000', name: 'My Blog' };
    const a = svc().hostnameFor(dep, 'nowrinkles.dev');
    const b = svc().hostnameFor({ ...dep, publicHostname: a }, 'nowrinkles.dev');
    expect(b).toBe(a);
  });

  it('distinguishes two tenants who both called their app the same thing', () => {
    const alice = svc().hostnameFor({ id: 'aaaaaaaa-0000-4000-8000-000000000000', name: 'blog' }, 'nowrinkles.dev');
    const bob = svc().hostnameFor({ id: 'bbbbbbbb-0000-4000-8000-000000000000', name: 'blog' }, 'nowrinkles.dev');
    expect(alice).not.toBe(bob);
    expect(alice.startsWith('blog-')).toBe(true);
  });

  it('produces a DNS-safe label from an awkward app name', () => {
    const h = svc().hostnameFor({ id: 'ffffffff-0000-4000-8000-000000000000', name: 'My  App!! v2' }, 'nowrinkles.dev');
    expect(h).toMatch(/^[a-z0-9-]+\.nowrinkles\.dev$/);
  });
});

describe('buildCaddyContent', () => {
  it('rewrites Host to the app ingress hostname, not the public one', () => {
    const c = (createService() as any).buildCaddyContent('blog-abc123.nowrinkles.dev', '100.64.0.5:32080', 'blog.apps.local');
    expect(c).toContain('blog-abc123.nowrinkles.dev {');
    expect(c).toContain('reverse_proxy 100.64.0.5:32080');
    expect(c).toContain('header_up Host blog.apps.local');
  });

  it('disables proxy timeouts so streaming apps are not severed', () => {
    const c = (createService() as any).buildCaddyContent('a.nowrinkles.dev', '10.0.0.1:80', 'a.apps.local');
    expect(c).toContain('read_timeout 0');
    expect(c).toContain('write_timeout 0');
  });
});
