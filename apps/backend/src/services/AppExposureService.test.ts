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
const mockSpawnStdoutOn = vi.fn((event: string, cb: Function) => {
  if (event === 'data') {
    setTimeout(() => cb(Buffer.from('your url is: https://myapp.loca.lt\n')), 10);
  }
});
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

let AppExposureService: any;

beforeAll(async () => {
  const mod = await import('./AppExposureService.ts');
  AppExposureService = mod.AppExposureService;
});

function createService() {
  const db = { getDeployments: mockGetDeployments, saveDeployment: mockSaveDeployment };
  const infra = { runKubectl: mockRunKubectl };
  const clusters = { getById: mockGetById, getKubeconfigPath: mockGetKubeconfigPath };
  return new AppExposureService(db, infra, clusters);
}

beforeEach(() => {
  vi.clearAllMocks();
});

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
    const content = (createService() as any).buildConfContent('my-app', '172.17.0.1:31301');
    expect(content).toContain('server {');
    expect(content).toContain('server_name my-app ~^my-app\\..*$;');
    expect(content).toContain('set $upstream "172.17.0.1:31301";');
  });
  it('handles namespaces with hyphens', () => {
    const content = (createService() as any).buildConfContent('my-long-app-name', '10.0.0.1:8080');
    expect(content).toContain('server_name my-long-app-name ~^my-long-app-name\\..*$;');
  });
});

describe('syncExposedApps', () => {
  const mockCluster = { id: 'c1', name: 'Tc', provider: 'k3d' as const, status: 'healthy' as const };
  const mockDep = { id: 'd1', name: 'MyApp', clusterId: 'c1', strategy: 'native' as const, status: 'running' as const, isExposed: true, exposureUrl: 'http://x' };
  const svcJson = JSON.stringify({ items: [{ metadata: { name: 'm-web' }, spec: { type: 'NodePort', ports: [{ port: 80, nodePort: 31301 }] } }] });

  it('writes conf.d and removes stale configs', async () => {
    mockGetDeployments.mockResolvedValue([mockDep]);
    mockGetById.mockResolvedValue(mockCluster);
    mockGetKubeconfigPath.mockResolvedValue('/tmp/kubeconfig');
    mockRunKubectl.mockResolvedValue(svcJson);
    mockReaddir.mockResolvedValue(['default.conf', 'myapp.conf', 'old.conf']);

    const svc = createService();
    await svc.syncExposedApps();

    expect(mockRunKubectl).toHaveBeenCalledWith(['get', 'svc', '-n', 'myapp', '-o', 'json'], '/tmp/kubeconfig');
    expect(mockWriteFile).toHaveBeenCalledOnce();
    expect(mockUnlink).toHaveBeenCalled();
  });

  it('removes stale configs when no deployments exposed', async () => {
    mockGetDeployments.mockResolvedValue([{ ...mockDep, isExposed: false }]);
    mockReaddir.mockResolvedValue(['default.conf', 'myapp.conf', 'stale.conf']);

    await createService().syncExposedApps();
    expect(mockUnlink).toHaveBeenCalledTimes(2);
  });

  it('preserves default.conf', async () => {
    mockGetDeployments.mockResolvedValue([]);
    mockReaddir.mockResolvedValue(['default.conf', 'stale-app.conf']);

    await createService().syncExposedApps();
    expect(mockUnlink).toHaveBeenCalledOnce();
    expect(mockUnlink.mock.calls[0][0]).toContain('stale-app.conf');
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
    mockRunKubectl.mockResolvedValue(JSON.stringify({ items: [{ metadata: { name: 'm-w' }, spec: { type: 'NodePort', ports: [{ port: 80, nodePort: 31301 }] } }] }));
    const r = await (createService() as any).buildUpstreamTarget(dep, cluster);
    expect(r).toEqual({ namespace: 'myapp', backendTarget: '172.17.0.1:31301' });
  });

  it('prefers web over DB services', async () => {
    mockGetKubeconfigPath.mockResolvedValue('/tmp/k');
    mockRunKubectl.mockResolvedValue(JSON.stringify({ items: [
      { metadata: { name: 'm-pg' }, spec: { ports: [{ port: 5432 }] } },
      { metadata: { name: 'm-w' }, spec: { type: 'NodePort', ports: [{ port: 80, nodePort: 31301 }] } },
    ] }));
    const r = await (createService() as any).buildUpstreamTarget(dep, cluster);
    expect(r.backendTarget).toBe('172.17.0.1:31301');
  });

  it('throws when no web services', async () => {
    mockGetKubeconfigPath.mockResolvedValue('/tmp/k');
    mockRunKubectl.mockResolvedValue(JSON.stringify({ items: [] }));
    await expect((createService() as any).buildUpstreamTarget(dep, cluster)).rejects.toThrow('No proxyable web services');
  });

  it('throws when NodePort missing for k3d', async () => {
    mockGetKubeconfigPath.mockResolvedValue('/tmp/k');
    mockRunKubectl.mockResolvedValue(JSON.stringify({ items: [{ metadata: { name: 'm-w' }, spec: { type: 'ClusterIP', ports: [{ port: 80 }] } }] }));
    await expect((createService() as any).buildUpstreamTarget(dep, cluster)).rejects.toThrow('does not have a nodePort');
  });
});

describe('unexpose', () => {
  it('removes conf.d and reloads nginx', async () => {
    mockGetDeployments.mockResolvedValue([{ id: 'd1', name: 'MyApp', clusterId: 'c1', strategy: 'native' as const, status: 'running' as const, isExposed: true }]);
    mockSaveDeployment.mockResolvedValue(undefined);

    const result = await createService().unexpose('d1');

    expect(mockUnlink).toHaveBeenCalled();
    const saved = mockSaveDeployment.mock.calls[0][0];
    expect(saved.isExposed).toBe(false);
    expect(saved.exposureUrl).toBeUndefined();
    expect(result.isExposed).toBe(false);
  });
});

describe('expose', () => {
  it('writes conf.d and reloads nginx', async () => {
    mockGetDeployments.mockResolvedValue([{ id: 'd1', name: 'MyApp', clusterId: 'c1', strategy: 'native' as const, status: 'running' as const }]);
    mockGetById.mockResolvedValue({ id: 'c1', name: 'Tc', provider: 'k3d' as const, status: 'healthy' as const });
    mockGetKubeconfigPath.mockResolvedValue('/tmp/k');
    mockRunKubectl.mockResolvedValue(JSON.stringify({ items: [{ metadata: { name: 'm-w' }, spec: { type: 'NodePort', ports: [{ port: 80, nodePort: 31301 }] } }] }));
    mockSaveDeployment.mockResolvedValue(undefined);

    const result = await createService().expose('d1');

    expect(mockWriteFile).toHaveBeenCalledOnce();
    expect(result.isExposed).toBe(true);
    expect(result.exposureUrl).toBe('https://myapp.loca.lt');
  });

  it('throws when not found', async () => {
    mockGetDeployments.mockResolvedValue([]);
    await expect(createService().expose('x')).rejects.toThrow('Deployment not found');
  });
});
