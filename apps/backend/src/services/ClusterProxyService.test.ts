import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

vi.mock('node:url', () => ({
  fileURLToPath: () => '/app/src/services/ClusterProxyService.ts',
}));

const mockSpawn = vi.fn();
vi.mock('child_process', () => ({
  spawn: mockSpawn,
}));

let ClusterProxyService: any;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  const mod = await import('./ClusterProxyService.js');
  ClusterProxyService = mod.ClusterProxyService;
});

afterEach(() => {
  vi.useRealTimers();
});

function fakeChildProcess(): ChildProcess & { _stdout: EventEmitter; _stderr: EventEmitter; _killed: boolean } {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const proc = new EventEmitter() as ChildProcess & { _stdout: EventEmitter; _stderr: EventEmitter; _killed: boolean };
  proc.stdout = stdout as any;
  proc.stderr = stderr as any;
  proc.kill = vi.fn(() => { proc._killed = true; return true; });
  proc._stdout = stdout;
  proc._stderr = stderr;
  proc._killed = false;
  return proc;
}

function emitForwarding(child: ChildProcess, port: number) {
  (child as any)._stdout.emit('data', Buffer.from(`Forwarding from 127.0.0.1:${port} -> 9090\n`));
}

describe('ClusterProxyService', () => {
  describe('ensurePortForward', () => {
    it('returns URL on successful port-forward', async () => {
      const child = fakeChildProcess();
      mockSpawn.mockReturnValue(child);

      const svc = new ClusterProxyService();
      const resultPromise = svc.ensurePortForward('c1', 'prometheus', '/tmp/kubeconfig-c1');

      // spawn was called, wait for stdout
      expect(mockSpawn).toHaveBeenCalledOnce();
      emitForwarding(child, 54321);

      const url = await resultPromise;
      expect(url).toBe('http://127.0.0.1:54321/');
    });

    it('passes correct kubectl args', async () => {
      const child = fakeChildProcess();
      mockSpawn.mockReturnValue(child);

      const svc = new ClusterProxyService();
      const p = svc.ensurePortForward('c1', 'grafana', '/tmp/kubeconfig-c1');
      emitForwarding(child, 12345);
      await p;

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).toContain('port-forward');
      expect(args).toContain('--kubeconfig');
      expect(args).toContain('/tmp/kubeconfig-c1');
      expect(args).toContain('-n');
      expect(args).toContain('monitoring');
      expect(args).toContain('svc/kube-prometheus-stack-grafana');
      expect(args).toContain('0:80');
    });

    it('uses deployment/traefik on port 9000 for traefik dashboard', async () => {
      const child = fakeChildProcess();
      mockSpawn.mockReturnValue(child);

      const svc = new ClusterProxyService();
      const p = svc.ensurePortForward('c1', 'traefik', '/tmp/kubeconfig-c1');
      emitForwarding(child, 11111);
      const url = await p;

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).toContain('-n');
      expect(args).toContain('kube-system');
      expect(args).toContain('deployment/traefik');
      expect(args).toContain('0:9000');
      expect(url).toBe('http://127.0.0.1:11111/dashboard/');
    });

    it('throws for unknown service key', async () => {
      const svc = new ClusterProxyService();
      await expect(
        svc.ensurePortForward('c1', 'unknown', '/tmp/kubeconfig-c1'),
      ).rejects.toThrow('Unknown service: unknown');
    });

    it('reuses existing port-forward for same cluster+service', async () => {
      const child = fakeChildProcess();
      mockSpawn.mockReturnValue(child);

      const svc = new ClusterProxyService();

      const p1 = svc.ensurePortForward('c1', 'prometheus', '/tmp/kubeconfig-c1');
      emitForwarding(child, 40001);
      const url1 = await p1;
      expect(url1).toBe('http://127.0.0.1:40001/');

      // Second call should reuse — no new spawn
      const url2 = await svc.ensurePortForward('c1', 'prometheus', '/tmp/kubeconfig-c1');
      expect(url2).toBe('http://127.0.0.1:40001/');
      expect(mockSpawn).toHaveBeenCalledOnce();
    });

    it('spawns separate processes for different services', async () => {
      const child1 = fakeChildProcess();
      const child2 = fakeChildProcess();
      mockSpawn.mockReturnValueOnce(child1).mockReturnValueOnce(child2);

      const svc = new ClusterProxyService();

      const p1 = svc.ensurePortForward('c1', 'prometheus', '/tmp/kubeconfig-c1');
      emitForwarding(child1, 40001);
      await p1;

      const p2 = svc.ensurePortForward('c1', 'grafana', '/tmp/kubeconfig-c1');
      emitForwarding(child2, 40002);
      await p2;

      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });

    it('rejects on spawn error', async () => {
      const child = fakeChildProcess();
      mockSpawn.mockReturnValue(child);

      const svc = new ClusterProxyService();
      const p = svc.ensurePortForward('c1', 'prometheus', '/tmp/kubeconfig-c1');

      child.emit('error', new Error('ENOENT'));

      await expect(p).rejects.toThrow('ENOENT');
    });

    it('rejects on non-zero exit with stderr', async () => {
      const child = fakeChildProcess();
      mockSpawn.mockReturnValue(child);

      const svc = new ClusterProxyService();
      const p = svc.ensurePortForward('c1', 'prometheus', '/tmp/kubeconfig-c1');

      (child as any)._stderr.emit('data', Buffer.from('Error: service not found\n'));
      child.emit('close', 1);

      await expect(p).rejects.toThrow('port-forward exited with code 1: Error: service not found');
    });

    it('rejects on close with no stdout and no stderr', async () => {
      const child = fakeChildProcess();
      mockSpawn.mockReturnValue(child);

      const svc = new ClusterProxyService();
      const p = svc.ensurePortForward('c1', 'prometheus', '/tmp/kubeconfig-c1');

      child.emit('close', 1);

      await expect(p).rejects.toThrow('port-forward exited with code 1: no stderr');
    });

    it('spawns separate processes for different clusters', async () => {
      const child1 = fakeChildProcess();
      const child2 = fakeChildProcess();
      mockSpawn.mockReturnValueOnce(child1).mockReturnValueOnce(child2);

      const svc = new ClusterProxyService();

      const p1 = svc.ensurePortForward('c1', 'prometheus', '/tmp/kubeconfig-c1');
      emitForwarding(child1, 40001);
      await p1;

      const p2 = svc.ensurePortForward('c2', 'prometheus', '/tmp/kubeconfig-c2');
      emitForwarding(child2, 40002);
      await p2;

      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });
  });

  describe('stopForCluster', () => {
    it('kills all child processes for a cluster', async () => {
      const child1 = fakeChildProcess();
      const child2 = fakeChildProcess();
      mockSpawn.mockReturnValueOnce(child1).mockReturnValueOnce(child2);

      const svc = new ClusterProxyService();

      const p1 = svc.ensurePortForward('c1', 'prometheus', '/tmp/kubeconfig-c1');
      emitForwarding(child1, 40001);
      await p1;

      const p2 = svc.ensurePortForward('c1', 'grafana', '/tmp/kubeconfig-c1');
      emitForwarding(child2, 40002);
      await p2;

      svc.stopForCluster('c1');

      expect(child1.kill).toHaveBeenCalledOnce();
      expect(child2.kill).toHaveBeenCalledOnce();
    });

    it('does not affect other clusters', async () => {
      const child1 = fakeChildProcess();
      const child2 = fakeChildProcess();
      mockSpawn.mockReturnValueOnce(child1).mockReturnValueOnce(child2);

      const svc = new ClusterProxyService();

      const p1 = svc.ensurePortForward('c1', 'prometheus', '/tmp/kubeconfig-c1');
      emitForwarding(child1, 40001);
      await p1;

      const p2 = svc.ensurePortForward('c2', 'prometheus', '/tmp/kubeconfig-c2');
      emitForwarding(child2, 40002);
      await p2;

      svc.stopForCluster('c1');

      expect(child1.kill).toHaveBeenCalledOnce();
      expect(child2.kill).not.toHaveBeenCalled();
    });

    it('is safe to call with unknown cluster', () => {
      const svc = new ClusterProxyService();
      expect(() => svc.stopForCluster('nonexistent')).not.toThrow();
    });

    it('allows new port-forward after stop', async () => {
      const child1 = fakeChildProcess();
      const child2 = fakeChildProcess();
      mockSpawn.mockReturnValueOnce(child1).mockReturnValueOnce(child2);

      const svc = new ClusterProxyService();

      const p1 = svc.ensurePortForward('c1', 'prometheus', '/tmp/kubeconfig-c1');
      emitForwarding(child1, 40001);
      await p1;

      svc.stopForCluster('c1');

      // After stop, a new port-forward should be spawned
      const p2 = svc.ensurePortForward('c1', 'prometheus', '/tmp/kubeconfig-c1');
      emitForwarding(child2, 40002);
      const url = await p2;

      expect(url).toBe('http://127.0.0.1:40002/');
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });
  });

  describe('stopAll', () => {
    it('kills all child processes across all clusters', async () => {
      const child1 = fakeChildProcess();
      const child2 = fakeChildProcess();
      mockSpawn.mockReturnValueOnce(child1).mockReturnValueOnce(child2);

      const svc = new ClusterProxyService();

      const p1 = svc.ensurePortForward('c1', 'prometheus', '/tmp/kubeconfig-c1');
      emitForwarding(child1, 40001);
      await p1;

      const p2 = svc.ensurePortForward('c2', 'grafana', '/tmp/kubeconfig-c2');
      emitForwarding(child2, 40002);
      await p2;

      svc.stopAll();

      expect(child1.kill).toHaveBeenCalledOnce();
      expect(child2.kill).toHaveBeenCalledOnce();
    });

    it('is safe to call when no forwards exist', () => {
      const svc = new ClusterProxyService();
      expect(() => svc.stopAll()).not.toThrow();
    });
  });
});
