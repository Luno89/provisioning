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

  it('marks an instance\'s namespace as the pool\'s and its owner\'s, with its registry\'s port, holding it to baseline pod security', () => {
    expect(namespaceManifest('alice', 'u1', 35002)).toEqual({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: 'pool-alice',
        labels: {
          'koala.dev/pool': 'true',
          'koala.dev/owner': 'u1',
          'koala.dev/registry-port': '35002',
          'pod-security.kubernetes.io/enforce': 'baseline',
          'pod-security.kubernetes.io/enforce-version': 'latest',
        },
      },
    });
  });

  it('refuses any pod in a pool namespace that does not run under gVisor, whoever asks', () => {
    const [policy, binding] = admissionManifests('127.0.0.1:5000/nowrinkles/app') as [any, any];
    expect(policy.spec.matchConstraints.namespaceSelector).toEqual({ matchLabels: { 'koala.dev/pool': 'true' } });
    expect(policy.spec.matchConstraints.resourceRules[0].resources).toEqual(['pods', 'pods/ephemeralcontainers']);
    expect(policy.spec.failurePolicy).toBe('Fail');
    expect(policy.spec.validations[0].expression).toBe("has(object.spec.runtimeClassName) && object.spec.runtimeClassName == 'gvisor'");
    expect(binding.spec).toEqual({ policyName: 'koala-pool-gvisor', validationActions: ['Deny'] });
  });

  it('lets a pool pod pull from the node\'s loopback only through its own instance\'s registry, or the platform\'s own image', () => {
    const [policy] = admissionManifests('127.0.0.1:5000/nowrinkles/app') as [any];
    const rule = policy.spec.validations[1].expression as string;
    expect(rule).toContain("image.startsWith('127.0.0.1:' + namespaceObject.metadata.labels['koala.dev/registry-port'] + '/')");
    expect(rule).toContain("image.startsWith('127.0.0.1:5000/nowrinkles/app:') || image.startsWith('127.0.0.1:5000/nowrinkles/app@')");
    for (const prefix of ['127.', 'localhost', '[::1]', '0.0.0.0', '[::]']) expect(rule).toContain(`image.startsWith('${prefix}')`);
    expect(policy.spec.variables[0].expression).toContain('ephemeralContainers');
  });

  it('runs a vcluster\'s control plane and every pod it syncs under gVisor, within its slot, with no node ports, its network policies enforced on the host', () => {
    const values = vclusterValues('alice', SLOT) as any;
    expect(values.controlPlane.statefulSet.runtimeClassName).toBe('gvisor');
    expect(values.controlPlane.proxy.extraSANs).toEqual(['alice.pool-alice.svc']);
    expect(values.sync.toHost.pods.runtimeClassName).toBe('gvisor');
    expect(values.policies.resourceQuota.quota).toMatchObject({
      'requests.memory': '6144Mi', 'requests.cpu': '2', 'services.nodeports': 0, 'services.loadbalancers': 0,
    });
    expect(values.policies.resourceQuota.quota).toMatchObject({ 'limits.memory': null, 'limits.cpu': null, 'limits.ephemeral-storage': null });
    expect(values.policies.networkPolicy.enabled).toBe(true);
    expect(values.sync.toHost.networkPolicies.enabled).toBe(true);
    expect(values.policies.limitRange.max).toEqual({ memory: '6144Mi', cpu: '2', 'ephemeral-storage': `${SLOT.storageGiB}Gi` });
  });

  it('lets a pool instance\'s pods out to the public internet only, never to cloud metadata, a private or mesh address, or a mail port', () => {
    const values = vclusterValues('alice', SLOT) as any;
    const workload = values.policies.networkPolicy.workload;
    expect(workload.publicEgress).toEqual({ enabled: false });
    expect(workload.egress).toEqual([{
      to: [{ ipBlock: { cidr: '0.0.0.0/0', except: ['10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16'] } }],
      ports: [
        { port: 1, endPort: 24, protocol: 'TCP' },
        { port: 26, endPort: 464, protocol: 'TCP' },
        { port: 466, endPort: 586, protocol: 'TCP' },
        { port: 588, endPort: 65535, protocol: 'TCP' },
        { port: 1, endPort: 65535, protocol: 'UDP' },
      ],
    }]);
  });

  it('keeps every container\'s default within a small slot', () => {
    const values = vclusterValues('tiny', { memoryMiB: 512, cpu: 1, storageGiB: 4 }) as any;
    expect(values.policies.limitRange.default).toEqual({ memory: '512Mi', cpu: '1', 'ephemeral-storage': '4Gi' });
    expect(values.policies.limitRange.max).toEqual({ memory: '512Mi', cpu: '1', 'ephemeral-storage': '4Gi' });
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

