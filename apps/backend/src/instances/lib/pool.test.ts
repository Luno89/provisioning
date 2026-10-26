import { describe, expect, it } from 'vitest';
import {
  admissionManifests, backendAccessManifest, FIRST_PORT, freePorts, LAST_PORT, namespaceManifest, poolChartValues, poolSlots, proxyCaddyfile,
  proxyManifests, vclusterValues, type PoolPorts,
} from './pool.js';

const SLOT = { memoryMiB: 6144, cpu: 2, storageGiB: 20 };

describe('the pool on a node', () => {
  it('holds as many slots as its memory has room for after what the node keeps for itself', () => {
    expect(poolSlots(65536, 8192, SLOT)).toBe(9);
    expect(poolSlots(8192, 8192, SLOT)).toBe(0);
    expect(poolSlots(4096, 8192, SLOT)).toBe(0);
  });

  it('gives each instance three ports of its own, reusing the ones a removed instance left', () => {
    expect(freePorts([])).toEqual({ backend: FIRST_PORT, edge: FIRST_PORT + 1, registry: FIRST_PORT + 2 });
    const first = freePorts([])!;
    const second = freePorts([first])!;
    expect(second.backend).toBe(FIRST_PORT + 3);
    expect(freePorts([second])).toEqual(first);
    const all: PoolPorts[] = [];
    for (let next = freePorts(all); next; next = freePorts(all)) all.push(next);
    expect(all).toHaveLength(Math.floor((LAST_PORT - FIRST_PORT + 1) / 3));
  });

  it('marks an instance\'s namespace as the pool\'s and its owner\'s, holding it to baseline pod security', () => {
    expect(namespaceManifest('alice', 'u1')).toEqual({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: 'pool-alice',
        labels: {
          'koala.dev/pool': 'true',
          'koala.dev/owner': 'u1',
          'pod-security.kubernetes.io/enforce': 'baseline',
          'pod-security.kubernetes.io/enforce-version': 'latest',
        },
      },
    });
  });

  it('refuses any pod in a pool namespace that does not run under gVisor, whoever asks', () => {
    const [policy, binding] = admissionManifests() as [any, any];
    expect(policy.spec.matchConstraints.namespaceSelector).toEqual({ matchLabels: { 'koala.dev/pool': 'true' } });
    expect(policy.spec.failurePolicy).toBe('Fail');
    expect(policy.spec.validations[0].expression).toBe("has(object.spec.runtimeClassName) && object.spec.runtimeClassName == 'gvisor'");
    expect(binding.spec).toEqual({ policyName: 'koala-pool-gvisor', validationActions: ['Deny'] });
  });

  it('runs a vcluster\'s control plane and every pod it syncs under gVisor, within its slot, with no node ports', () => {
    const values = vclusterValues('alice', SLOT) as any;
    expect(values.controlPlane.statefulSet.runtimeClassName).toBe('gvisor');
    expect(values.controlPlane.proxy.extraSANs).toEqual(['alice.pool-alice.svc']);
    expect(values.sync.toHost.pods.runtimeClassName).toBe('gvisor');
    expect(values.policies.resourceQuota.quota).toMatchObject({
      'requests.memory': '6144Mi', 'requests.cpu': '2', 'services.nodeports': 0, 'services.loadbalancers': 0,
    });
    expect(values.policies.resourceQuota.quota).toMatchObject({ 'limits.memory': null, 'limits.cpu': null, 'limits.ephemeral-storage': null });
    expect(values.policies.networkPolicy.enabled).toBe(true);
  });
});

describe('the proxy on the pool node', () => {
  const caddyfile = proxyCaddyfile([
    { name: 'bob', ports: { backend: 35003, edge: 35004, registry: 35005 } },
    { name: 'alice', ports: { backend: 35000, edge: 35001, registry: 35002 } },
  ], '100.64.0.9');

  it('serves each instance\'s backend and apps on the node\'s mesh address, whatever host they are asked for', () => {
    expect(caddyfile).toContain('http://:35000 {\n\tbind 100.64.0.9\n\treverse_proxy instance-x-nowrinkles-x-alice.pool-alice.svc.cluster.local:80 {');
    expect(caddyfile).toContain('http://:35001 {\n\tbind 100.64.0.9\n\treverse_proxy instance-edge-x-nowrinkles-x-alice.pool-alice.svc.cluster.local:80 {');
    expect(caddyfile.indexOf('pool-alice')).toBeLessThan(caddyfile.indexOf('pool-bob'));
    expect(caddyfile).toContain('read_timeout 0');
  });

  it('serves each instance\'s registry on the node\'s loopback only, for the node to pull from', () => {
    expect(caddyfile).toContain('http://:35002 {\n\tbind 127.0.0.1\n\treverse_proxy gitea-http-x-gitea-x-alice.pool-alice.svc.cluster.local:3000 {');
    expect(caddyfile.match(/bind 127\.0\.0\.1/g)).toHaveLength(2);
    expect(caddyfile.match(/bind 100\.64\.0\.9/g)).toHaveLength(4);
  });

  it('starts with no admin endpoint, and runs on the node\'s own network so it can bind there', () => {
    expect(proxyCaddyfile([], '100.64.0.9')).toBe('{\n\tadmin off\n\tauto_https off\n\tpersist_config off\n}\n\n');
    const [config, daemon] = proxyManifests(caddyfile) as [any, any];
    expect(config.data.Caddyfile).toBe(caddyfile);
    expect(daemon.spec.template.spec.hostNetwork).toBe(true);
    expect(daemon.spec.template.spec.containers[0].args).toContain('--watch');
  });
});

describe('the instance chart\'s values in the pool', () => {
  const values = poolChartValues({
    instanceId: 'inst-1', ownerId: 'u1', rootUrl: 'https://app.koala.dev', rootPublicKeys: '-----BEGIN PUBLIC KEY-----\nAAA\n-----END PUBLIC KEY-----',
    credential: 'cred', name: 'alice', domain: 'koala.dev', publicUrl: 'https://alice.koala.dev',
    image: { repository: '100.64.0.1:5001/nowrinkles/app', tag: 'abc' }, ports: { backend: 35000, edge: 35001, registry: 35002 },
    resources: { backend: { requests: { memory: '300Mi' } } },
  }) as any;

  it('installs in pool mode, pulling its own images through its loopback registry port', () => {
    expect(values.pool).toEqual({ enabled: true, registryPullHost: '127.0.0.1:35002' });
    expect(values.hostDocker).toBe(false);
    expect(values.routing).toEqual({ name: 'alice', domain: 'koala.dev' });
    expect(Buffer.from(values.instance.rootPublicKeys, 'base64').toString('utf8')).toContain('BEGIN PUBLIC KEY');
    expect(values.resources).toEqual({ backend: { requests: { memory: '300Mi' } } });
  });
});

describe('root\'s backend in a pool namespace', () => {
  it('is let in by binding its narrow account to the pool role there, and nowhere else', () => {
    expect(backendAccessManifest('alice')).toEqual({
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: { name: 'koala-backend', namespace: 'pool-alice' },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'koala-backend-pool' },
      subjects: [{ kind: 'ServiceAccount', name: 'koala-backend', namespace: 'kube-system' }],
    });
  });
});

