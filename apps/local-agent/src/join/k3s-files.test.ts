import { describe, expect, it } from 'vitest';
import { k3sConfig, K3S_NODE_PORTS, sudoRule, withMirror } from './k3s-files.js';

describe('k3s\'s settings on a machine', () => {
  it('answers on the machine\'s private address with its certificate, writes a kubeconfig the person\'s group reads, and runs no load balancer of its own', () => {
    expect(k3sConfig('100.64.0.7', 'luno')).toBe('disable:\n  - traefik\n  - servicelb\ntls-san:\n  - 100.64.0.7\nwrite-kubeconfig-mode: "0640"\nwrite-kubeconfig-group: luno\n');
    expect(K3S_NODE_PORTS).toBe('kube-proxy-arg+:\n  - nodeport-addresses=127.0.0.1/32,100.64.0.0/10\n');
  });

  it('adds a pull-through cache as a registry\'s mirror, its endpoint the cache rather than the registry', () => {
    expect(withMirror(undefined, 'docker.io', 'http://127.0.0.1:5101')).toBe('mirrors:\n  "docker.io":\n    endpoint:\n      - "http://127.0.0.1:5101"\n');
    const both = withMirror(withMirror(undefined, 'registry.koala.test:5000'), 'docker.io', 'http://127.0.0.1:5101');
    expect(both).toBe('mirrors:\n  "docker.io":\n    endpoint:\n      - "http://127.0.0.1:5101"\n  "registry.koala.test:5000":\n    endpoint:\n      - "http://registry.koala.test:5000"\n');
  });

  it('adds root\'s registry as a mirror, keeping every mirror already there', () => {
    expect(withMirror(undefined, 'registry.koala.test:5000')).toBe('mirrors:\n  "registry.koala.test:5000":\n    endpoint:\n      - "http://registry.koala.test:5000"\n');
    expect(withMirror('mirrors:\n  "docker.io":\n    endpoint:\n      - "https://mirror.example"\nconfigs: {}\n', 'registry.koala.test:5000')).toBe(
      'mirrors:\n  "registry.koala.test:5000":\n    endpoint:\n      - "http://registry.koala.test:5000"\n  "docker.io":\n    endpoint:\n      - "https://mirror.example"\nconfigs: {}\n',
    );
    expect(withMirror('configs: {}\n', 'r.test')).toBe('configs: {}\nmirrors:\n  "r.test":\n    endpoint:\n      - "http://r.test"\n');
  });

  it('leaves the registries alone once the mirror is there, and when root names no registry', () => {
    const there = 'mirrors:\n  "r.test":\n    endpoint:\n      - "http://elsewhere"\n';
    expect(withMirror(there, 'r.test')).toBe(there);
    expect(withMirror(undefined, '')).toBeUndefined();
    expect(withMirror('configs: {}\n', '')).toBe('configs: {}\n');
  });

  it('lets only the person start and stop k3s, and remove what the join installed, without a password', () => {
    expect(sudoRule('luno', '/usr/bin/systemctl')).toBe('luno ALL=(root) NOPASSWD: /usr/bin/systemctl start k3s, /usr/bin/systemctl stop k3s, /usr/local/bin/k3s-killall.sh, /usr/local/lib/koala/machine-uninstall.sh\n');
  });
});
