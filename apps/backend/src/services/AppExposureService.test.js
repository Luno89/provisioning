"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const mockReaddir = vitest_1.vi.fn();
const mockWriteFile = vitest_1.vi.fn();
const mockMkdir = vitest_1.vi.fn();
const mockUnlink = vitest_1.vi.fn();
vitest_1.vi.mock('node:fs/promises', () => ({
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
const mockExec = vitest_1.vi.fn((cmd, cb) => cb(null, { stdout: '', stderr: '' }));
vitest_1.vi.mock('node:child_process', () => ({
    exec: mockExec,
}));
vitest_1.vi.mock('node:util', () => ({
    promisify: (fn) => {
        return (...args) => Promise.resolve({ stdout: '', stderr: '' });
    },
}));
vitest_1.vi.mock('node:url', () => ({
    fileURLToPath: () => '/app/src/services/AppExposureService.ts',
}));
const mockGetDeployments = vitest_1.vi.fn();
const mockSaveDeployment = vitest_1.vi.fn();
const mockGetById = vitest_1.vi.fn();
const mockGetKubeconfigPath = vitest_1.vi.fn();
const mockRunKubectl = vitest_1.vi.fn();
let AppExposureService;
(0, vitest_1.beforeAll)(async () => {
    const mod = await import('./AppExposureService.js');
    AppExposureService = mod.AppExposureService;
});
function createService() {
    const db = { getDeployments: mockGetDeployments, saveDeployment: mockSaveDeployment };
    const infra = { runKubectl: mockRunKubectl };
    const clusters = { getById: mockGetById, getKubeconfigPath: mockGetKubeconfigPath };
    return new AppExposureService(db, infra, clusters);
}
(0, vitest_1.beforeEach)(() => {
    vitest_1.vi.clearAllMocks();
});
(0, vitest_1.describe)('sanitize', () => {
    (0, vitest_1.it)('converts to lowercase and replaces non-alphanumeric chars with hyphens', () => {
        (0, vitest_1.expect)(createService().sanitize('Hello World-Foo!')).toBe('hello-world-foo');
    });
    (0, vitest_1.it)('removes leading and trailing hyphens', () => {
        (0, vitest_1.expect)(createService().sanitize('--hello--')).toBe('hello');
    });
    (0, vitest_1.it)('collapses multiple hyphens', () => {
        (0, vitest_1.expect)(createService().sanitize('a---b---c')).toBe('a-b-c');
    });
});
(0, vitest_1.describe)('buildConfContent', () => {
    (0, vitest_1.it)('generates a valid nginx server block', () => {
        const content = createService().buildConfContent('my-app', '172.17.0.1:31301');
        (0, vitest_1.expect)(content).toContain('server {');
        (0, vitest_1.expect)(content).toContain('server_name my-app ~^my-app\\..*$;');
        (0, vitest_1.expect)(content).toContain('set $upstream "172.17.0.1:31301";');
    });
    (0, vitest_1.it)('handles namespaces with hyphens', () => {
        const content = createService().buildConfContent('my-long-app-name', '10.0.0.1:8080');
        (0, vitest_1.expect)(content).toContain('server_name my-long-app-name ~^my-long-app-name\\..*$;');
    });
});
(0, vitest_1.describe)('syncExposedApps', () => {
    const mockCluster = { id: 'c1', name: 'Tc', provider: 'k3d', status: 'healthy' };
    const mockDep = { id: 'd1', name: 'MyApp', clusterId: 'c1', strategy: 'native', status: 'running', isExposed: true, exposureUrl: 'http://x' };
    const svcJson = JSON.stringify({ items: [{ metadata: { name: 'm-web' }, spec: { type: 'NodePort', ports: [{ port: 80, nodePort: 31301 }] } }] });
    (0, vitest_1.it)('writes conf.d and removes stale configs', async () => {
        mockGetDeployments.mockResolvedValue([mockDep]);
        mockGetById.mockResolvedValue(mockCluster);
        mockGetKubeconfigPath.mockResolvedValue('/tmp/kubeconfig');
        mockRunKubectl.mockResolvedValue(svcJson);
        mockReaddir.mockResolvedValue(['default.conf', 'myapp.conf', 'old.conf']);
        const svc = createService();
        await svc.syncExposedApps();
        (0, vitest_1.expect)(mockRunKubectl).toHaveBeenCalledWith(['get', 'svc', '-n', 'myapp', '-o', 'json'], '/tmp/kubeconfig');
        (0, vitest_1.expect)(mockWriteFile).toHaveBeenCalledOnce();
        (0, vitest_1.expect)(mockUnlink).toHaveBeenCalled();
    });
    (0, vitest_1.it)('removes stale configs when no deployments exposed', async () => {
        mockGetDeployments.mockResolvedValue([{ ...mockDep, isExposed: false }]);
        mockReaddir.mockResolvedValue(['default.conf', 'myapp.conf', 'stale.conf']);
        await createService().syncExposedApps();
        (0, vitest_1.expect)(mockUnlink).toHaveBeenCalledTimes(2);
    });
    (0, vitest_1.it)('preserves default.conf', async () => {
        mockGetDeployments.mockResolvedValue([]);
        mockReaddir.mockResolvedValue(['default.conf', 'stale-app.conf']);
        await createService().syncExposedApps();
        (0, vitest_1.expect)(mockUnlink).toHaveBeenCalledOnce();
        (0, vitest_1.expect)(mockUnlink.mock.calls[0][0]).toContain('stale-app.conf');
    });
    (0, vitest_1.it)('handles missing cluster gracefully', async () => {
        mockGetDeployments.mockResolvedValue([mockDep]);
        mockGetById.mockResolvedValue(null);
        await createService().syncExposedApps();
        (0, vitest_1.expect)(mockWriteFile).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)('handles kubectl errors gracefully', async () => {
        mockGetDeployments.mockResolvedValue([mockDep]);
        mockGetById.mockResolvedValue(mockCluster);
        mockGetKubeconfigPath.mockResolvedValue('/tmp/kubeconfig');
        mockRunKubectl.mockRejectedValue(new Error('err'));
        mockReaddir.mockResolvedValue(['default.conf']);
        await createService().syncExposedApps();
        (0, vitest_1.expect)(mockWriteFile).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)('does nothing when no deployments exist', async () => {
        mockGetDeployments.mockResolvedValue([]);
        mockReaddir.mockResolvedValue(['default.conf']);
        await createService().syncExposedApps();
        (0, vitest_1.expect)(mockWriteFile).not.toHaveBeenCalled();
        (0, vitest_1.expect)(mockUnlink).not.toHaveBeenCalled();
        (0, vitest_1.expect)(mockExec).not.toHaveBeenCalled();
    });
});
(0, vitest_1.describe)('buildUpstreamTarget', () => {
    const cluster = { id: 'c1', name: 'Tc', provider: 'k3d', status: 'healthy' };
    const dep = { id: 'd1', name: 'MyApp', clusterId: 'c1', strategy: 'native', status: 'running' };
    (0, vitest_1.it)('builds target for k3d using NodePort', async () => {
        mockGetKubeconfigPath.mockResolvedValue('/tmp/k');
        mockRunKubectl.mockResolvedValue(JSON.stringify({ items: [{ metadata: { name: 'm-w' }, spec: { type: 'NodePort', ports: [{ port: 80, nodePort: 31301 }] } }] }));
        const r = await createService().buildUpstreamTarget(dep, cluster);
        (0, vitest_1.expect)(r).toEqual({ namespace: 'myapp', backendTarget: '172.17.0.1:31301' });
    });
    (0, vitest_1.it)('prefers web over DB services', async () => {
        mockGetKubeconfigPath.mockResolvedValue('/tmp/k');
        mockRunKubectl.mockResolvedValue(JSON.stringify({ items: [
                { metadata: { name: 'm-pg' }, spec: { ports: [{ port: 5432 }] } },
                { metadata: { name: 'm-w' }, spec: { type: 'NodePort', ports: [{ port: 80, nodePort: 31301 }] } },
            ] }));
        const r = await createService().buildUpstreamTarget(dep, cluster);
        (0, vitest_1.expect)(r.backendTarget).toBe('172.17.0.1:31301');
    });
    (0, vitest_1.it)('throws when no web services', async () => {
        mockGetKubeconfigPath.mockResolvedValue('/tmp/k');
        mockRunKubectl.mockResolvedValue(JSON.stringify({ items: [] }));
        await (0, vitest_1.expect)(createService().buildUpstreamTarget(dep, cluster)).rejects.toThrow('No proxyable web services');
    });
    (0, vitest_1.it)('throws when NodePort missing for k3d', async () => {
        mockGetKubeconfigPath.mockResolvedValue('/tmp/k');
        mockRunKubectl.mockResolvedValue(JSON.stringify({ items: [{ metadata: { name: 'm-w' }, spec: { type: 'ClusterIP', ports: [{ port: 80 }] } }] }));
        await (0, vitest_1.expect)(createService().buildUpstreamTarget(dep, cluster)).rejects.toThrow('does not have a nodePort');
    });
});
(0, vitest_1.describe)('unexpose', () => {
    (0, vitest_1.it)('removes conf.d and reloads nginx', async () => {
        mockGetDeployments.mockResolvedValue([{ id: 'd1', name: 'MyApp', clusterId: 'c1', strategy: 'native', status: 'running', isExposed: true }]);
        mockSaveDeployment.mockResolvedValue(undefined);
        const result = await createService().unexpose('d1');
        (0, vitest_1.expect)(mockUnlink).toHaveBeenCalled();
        const saved = mockSaveDeployment.mock.calls[0][0];
        (0, vitest_1.expect)(saved.isExposed).toBe(false);
        (0, vitest_1.expect)(saved.exposureUrl).toBeUndefined();
        (0, vitest_1.expect)(result.isExposed).toBe(false);
    });
});
(0, vitest_1.describe)('expose', () => {
    (0, vitest_1.it)('writes conf.d and reloads nginx', async () => {
        mockGetDeployments.mockResolvedValue([{ id: 'd1', name: 'MyApp', clusterId: 'c1', strategy: 'native', status: 'running' }]);
        mockGetById.mockResolvedValue({ id: 'c1', name: 'Tc', provider: 'k3d', status: 'healthy' });
        mockGetKubeconfigPath.mockResolvedValue('/tmp/k');
        mockRunKubectl.mockResolvedValue(JSON.stringify({ items: [{ metadata: { name: 'm-w' }, spec: { type: 'NodePort', ports: [{ port: 80, nodePort: 31301 }] } }] }));
        mockSaveDeployment.mockResolvedValue(undefined);
        const result = await createService().expose('d1');
        (0, vitest_1.expect)(mockWriteFile).toHaveBeenCalledOnce();
        (0, vitest_1.expect)(result.isExposed).toBe(true);
        (0, vitest_1.expect)(result.exposureUrl).toBe('http://myapp.localhost:8000');
    });
    (0, vitest_1.it)('throws when not found', async () => {
        mockGetDeployments.mockResolvedValue([]);
        await (0, vitest_1.expect)(createService().expose('x')).rejects.toThrow('Deployment not found');
    });
});
//# sourceMappingURL=AppExposureService.test.js.map