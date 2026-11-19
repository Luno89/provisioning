import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { Followed, ProcessResult } from '../../platform/index.js';
import { ClusterProxyService, sharedClusterProxy, type ProxyAccess } from './ClusterProxyService.js';

interface Forward {
  cluster: unknown;
  args: readonly string[];
  print(text: string): void;
  end(result: ProcessResult): void;
  fail(err: Error): void;
  stop: ReturnType<typeof vi.fn>;
}

let access: MockProxy<ProxyAccess>;
let forwards: Forward[];

beforeEach(() => {
  vi.useFakeTimers();
  forwards = [];
  access = mock<ProxyAccess>();
  access.kubectl.mockResolvedValue('');
  access.follow.mockImplementation(async (cluster, args, onOutput) => {
    let end: (result: ProcessResult) => void = () => undefined;
    let fail: (err: Error) => void = () => undefined;
    const ended = new Promise<ProcessResult>((done, failed) => { end = done; fail = failed; });
    const stop = vi.fn();
    forwards.push({ cluster, args, print: onOutput, end, fail, stop });
    return { pid: undefined, stop, ended } satisfies Followed;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const started = async (count: number) => {
  for (let tries = 0; tries < 20 && forwards.length < count; tries += 1) await Promise.resolve();
  return forwards[count - 1]!;
};

const forwarding = (port: number) => `Forwarding from 127.0.0.1:${port} -> 9090\n`;

describe('ClusterProxyService', () => {
  describe('ensurePortForward', () => {
    it('starts kubectl port-forward through ClusterAccess on the cluster asked for, and answers the port it prints', async () => {
      const svc = new ClusterProxyService(access, async () => false);
      const url = svc.ensurePortForward('c1', 'prometheus');
      const forward = await started(1);
      forward.print(forwarding(54321));
      expect(await url).toBe('http://localhost:54321/');
      expect(forward.cluster).toBe('c1');
      expect(forward.args).toEqual(['port-forward', '--address', '127.0.0.1', '-n', 'monitoring', 'svc/kube-prometheus-stack-prometheus', '0:9090']);
    });

    it('reads the port when kubectl prints it in pieces', async () => {
      const svc = new ClusterProxyService(access, async () => false);
      const url = svc.ensurePortForward('c1', 'prometheus');
      const forward = await started(1);
      forward.print('Forwarding from 127.0.');
      forward.print('0.1:40123 -> 9090\n');
      expect(await url).toBe('http://localhost:40123/');
    });

    it('takes a Reach as well as a cluster id', async () => {
      const svc = new ClusterProxyService(access, async () => false);
      const reach = { clusterId: 'machine-desk', kind: 'machine' as const, kubeconfig: 'apiVersion: v1\n' };
      const url = svc.ensurePortForward(reach, 'grafana');
      const forward = await started(1);
      forward.print(forwarding(40100));
      await url;
      expect(forward.cluster).toBe(reach);
    });

    it('uses deployment/traefik on port 8080 for the traefik dashboard, with its path', async () => {
      const svc = new ClusterProxyService(access, async () => false);
      const url = svc.ensurePortForward('c1', 'traefik');
      const forward = await started(1);
      forward.print(forwarding(40200));
      expect(await url).toBe('http://localhost:40200/dashboard/');
      expect(forward.args).toEqual(['port-forward', '--address', '127.0.0.1', '-n', 'traefik', 'deployment/traefik', '0:8080']);
    });

    it('throws for an unknown service, starting nothing', async () => {
      const svc = new ClusterProxyService(access, async () => false);
      await expect(svc.ensurePortForward('c1', 'unknown')).rejects.toThrow('Unknown service: unknown');
      expect(access.follow).not.toHaveBeenCalled();
    });

    it('reuses the forward it has for the same cluster and service', async () => {
      const svc = new ClusterProxyService(access, async () => false);
      const first = svc.ensurePortForward('c1', 'prometheus');
      (await started(1)).print(forwarding(40001));
      expect(await first).toBe('http://localhost:40001/');
      expect(await svc.ensurePortForward('c1', 'prometheus')).toBe('http://localhost:40001/');
      expect(access.follow).toHaveBeenCalledTimes(1);
    });

    it('starts one forward per service and per cluster', async () => {
      const svc = new ClusterProxyService(access, async () => false);
      const a = svc.ensurePortForward('c1', 'prometheus');
      (await started(1)).print(forwarding(40001));
      const b = svc.ensurePortForward('c1', 'grafana');
      (await started(2)).print(forwarding(40002));
      const c = svc.ensurePortForward('c2', 'prometheus');
      (await started(3)).print(forwarding(40003));
      expect([await a, await b, await c]).toEqual(['http://localhost:40001/', 'http://localhost:40002/', 'http://localhost:40003/']);
      expect(access.follow).toHaveBeenCalledTimes(3);
    });

    it('fails with ClusterAccess\'s refusal when the cluster cannot be reached, and tries again next time', async () => {
      access.follow.mockRejectedValueOnce(new Error('desk is stopped until something runs on it'));
      const svc = new ClusterProxyService(access, async () => false);
      await expect(svc.ensurePortForward('c1', 'prometheus')).rejects.toThrow('desk is stopped until something runs on it');
      const again = svc.ensurePortForward('c1', 'prometheus');
      (await started(1)).print(forwarding(40010));
      expect(await again).toBe('http://localhost:40010/');
    });

    it('fails with kubectl\'s own words when it exits before forwarding', async () => {
      const svc = new ClusterProxyService(access, async () => false);
      const url = svc.ensurePortForward('c1', 'prometheus');
      (await started(1)).end({ code: 1, stdout: '', stderr: 'Error: service not found\n' });
      await expect(url).rejects.toThrow('port-forward exited with code 1: Error: service not found');
    });

    it('says there was nothing on stderr when kubectl exits saying nothing', async () => {
      const svc = new ClusterProxyService(access, async () => false);
      const url = svc.ensurePortForward('c1', 'prometheus');
      (await started(1)).end({ code: 1, stdout: '', stderr: '' });
      await expect(url).rejects.toThrow('port-forward exited with code 1: no stderr');
    });

    it('fails when kubectl could not be started at all', async () => {
      const svc = new ClusterProxyService(access, async () => false);
      const url = svc.ensurePortForward('c1', 'prometheus');
      (await started(1)).fail(new Error('spawn kubectl ENOENT'));
      await expect(url).rejects.toThrow('spawn kubectl ENOENT');
    });

    it('starts a new forward once the one it had has ended', async () => {
      const svc = new ClusterProxyService(access, async () => false);
      const first = svc.ensurePortForward('c1', 'prometheus');
      const one = await started(1);
      one.print(forwarding(40001));
      await first;
      one.end({ code: 0, stdout: '', stderr: '' });
      await Promise.resolve();
      await Promise.resolve();
      const second = svc.ensurePortForward('c1', 'prometheus');
      (await started(2)).print(forwarding(40002));
      expect(await second).toBe('http://localhost:40002/');
    });
  });

  describe('stopping forwards', () => {
    it('stops a cluster\'s forwards and no other cluster\'s, and is safe for a cluster it never forwarded to', async () => {
      const svc = new ClusterProxyService(access, async () => false);
      const a = svc.ensurePortForward('c1', 'prometheus');
      const one = await started(1);
      one.print(forwarding(40001));
      const b = svc.ensurePortForward('c2', 'prometheus');
      const two = await started(2);
      two.print(forwarding(40002));
      await Promise.all([a, b]);
      svc.stopForCluster('c1');
      await Promise.resolve();
      expect(one.stop).toHaveBeenCalledOnce();
      expect(two.stop).not.toHaveBeenCalled();
      expect(() => svc.stopForCluster('nonexistent')).not.toThrow();
    });

    it('starts a new forward after a stop', async () => {
      const svc = new ClusterProxyService(access, async () => false);
      const first = svc.ensurePortForward('c1', 'prometheus');
      (await started(1)).print(forwarding(40001));
      await first;
      svc.stopForCluster('c1');
      const second = svc.ensurePortForward('c1', 'prometheus');
      (await started(2)).print(forwarding(40002));
      expect(await second).toBe('http://localhost:40002/');
      expect(access.follow).toHaveBeenCalledTimes(2);
    });

    it('stops every forward on every cluster, and is safe with none', async () => {
      const svc = new ClusterProxyService(access, async () => false);
      expect(() => svc.stopAll()).not.toThrow();
      const a = svc.ensurePortForward('c1', 'prometheus');
      const one = await started(1);
      one.print(forwarding(40001));
      const b = svc.ensurePortForward('c2', 'grafana');
      const two = await started(2);
      two.print(forwarding(40002));
      await Promise.all([a, b]);
      svc.stopAll();
      await Promise.resolve();
      expect(one.stop).toHaveBeenCalledOnce();
      expect(two.stop).toHaveBeenCalledOnce();
    });
  });

  describe('directServiceUrl', () => {
    const target = { service: 'tabbyapi', namespace: 'tabbyapi-production', remotePort: 5000 };

    it('reaches a service at its cluster address when this machine can, asking ClusterAccess, with no port-forward', async () => {
      access.kubectl.mockResolvedValue('10.43.100.81');
      const reachable = vi.fn(async () => true);
      const svc = new ClusterProxyService(access, reachable);
      expect(await svc.directServiceUrl('c1', 'model:tabby', target)).toBe('http://10.43.100.81:5000/');
      expect(access.kubectl).toHaveBeenCalledWith('c1', ['-n', 'tabbyapi-production', 'get', 'svc', 'tabbyapi', '-o', 'jsonpath={.spec.clusterIP}']);
      expect(reachable).toHaveBeenCalledWith('10.43.100.81', 5000, 1000);
      expect(access.follow).not.toHaveBeenCalled();
    });

    it('remembers the address, so a model call does not look it up each time', async () => {
      access.kubectl.mockResolvedValue('10.43.100.81');
      const svc = new ClusterProxyService(access, async () => true);
      await svc.directServiceUrl('c1', 'model:tabby', target);
      await svc.directServiceUrl('c1', 'model:tabby', target);
      expect(access.kubectl).toHaveBeenCalledTimes(1);
    });

    it('says no when the service has no cluster address or this machine cannot reach it, and asks again after a while', async () => {
      access.kubectl.mockResolvedValueOnce('None');
      expect(await new ClusterProxyService(access, async () => true).directServiceUrl('c1', 'model:tabby', target)).toBeUndefined();
      access.kubectl.mockResolvedValue('10.43.0.9');
      const svc = new ClusterProxyService(access, async () => false);
      access.kubectl.mockClear();
      expect(await svc.directServiceUrl('c2', 'model:tabby', target)).toBeUndefined();
      await svc.directServiceUrl('c2', 'model:tabby', target);
      expect(access.kubectl).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60_000);
      await svc.directServiceUrl('c2', 'model:tabby', target);
      expect(access.kubectl).toHaveBeenCalledTimes(2);
    });

    it('fails with ClusterAccess\'s refusal and asks again on the next call', async () => {
      access.kubectl.mockRejectedValueOnce(new Error('there is no cluster c3'));
      const svc = new ClusterProxyService(access, async () => true);
      await expect(svc.directServiceUrl('c3', 'model:tabby', target)).rejects.toThrow('there is no cluster c3');
      access.kubectl.mockResolvedValue('10.43.0.10');
      expect(await svc.directServiceUrl('c3', 'model:tabby', target)).toBe('http://10.43.0.10:5000/');
    });

    it('forwards through ClusterAccess when the cluster address cannot be reached from here', async () => {
      access.kubectl.mockResolvedValue('10.43.0.9');
      const svc = new ClusterProxyService(access, async () => false);
      const url = svc.serviceUrl('c1', 'model:tabby', target);
      (await started(1)).print(forwarding(40300));
      expect(await url).toBe('http://localhost:40300/');
      expect(forwards[0]!.args).toEqual(['port-forward', '--address', '127.0.0.1', '-n', 'tabbyapi-production', 'svc/tabbyapi', '0:5000']);
    });
  });
});

describe('sharedClusterProxy', () => {
  it('hands every caller with the same access the one proxy, so a forward one opens is the one another stops', () => {
    const first = sharedClusterProxy(access);
    expect(first).toBeInstanceOf(ClusterProxyService);
    expect(sharedClusterProxy(access)).toBe(first);
    expect(sharedClusterProxy(mock<ProxyAccess>())).not.toBe(first);
  });
});
