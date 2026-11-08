import { describe, expect, it } from 'vitest';
import { ROOT_CLUSTER_ID, koalasClusterId, machineToStart, ownReach, placeOf, serviceAccountFrom, serviceAccountKubeconfig, type KnownCluster } from './cluster-places.js';

const unsealed = (overrides: Partial<KnownCluster> = {}): KnownCluster =>
  ({ id: 'machine-dev2', name: 'machine-dev2', provider: 'machine', machineId: 'dev2', status: 'healthy', ...overrides });

const machine = (overrides: Partial<KnownCluster> = {}): KnownCluster => unsealed({ kubeconfigEnc: 'v2:k:sealed', ...overrides });

const instance = { koalaMachineId: 'dev1', root: false };

describe('where a cluster is, as ClusterAccess sees it', () => {
  it('finds the cluster Koala runs on by its machine, whatever its record holds', () => {
    expect(placeOf('machine-dev1', unsealed({ id: 'machine-dev1', machineId: 'dev1', status: 'stopped' }), instance)).toEqual({ kind: 'koala', clusterId: 'machine-dev1' });
  });

  it('knows the cluster Koala runs on by its machine\'s id before any record of it exists', () => {
    expect(placeOf('machine-dev1', undefined, instance)).toEqual({ kind: 'koala', clusterId: 'machine-dev1' });
  });

  it('finds another of the person\'s machines by the kubeconfig sealed on its record', () => {
    expect(placeOf('machine-dev2', machine(), instance)).toEqual({ kind: 'machine', clusterId: 'machine-dev2', sealed: 'v2:k:sealed' });
  });

  it('never starts a stopped machine to reach it, and says why it cannot be reached', () => {
    expect(placeOf('machine-dev2', machine({ status: 'stopped' }), instance)).toMatchObject({ kind: 'unreachable', why: 'stopped', reason: 'machine-dev2 is stopped until something runs on it' });
    expect(placeOf('machine-dev2', unsealed(), instance)).toMatchObject({ kind: 'unreachable', why: 'not-started' });
  });

  it('refuses a cluster of any other kind and one with no record', () => {
    expect(placeOf('provisioning-lunorica', machine({ id: 'provisioning-lunorica', name: 'provisioning-lunorica', provider: 'k3d' }), instance)).toMatchObject({ kind: 'unreachable', why: 'other-kind' });
    expect(placeOf('gone', undefined, instance)).toMatchObject({ kind: 'unreachable', why: 'unknown', reason: 'there is no cluster gone' });
  });

  it('reaches root\'s own cluster only on root', () => {
    expect(placeOf(ROOT_CLUSTER_ID, undefined, { root: true })).toEqual({ kind: 'root', clusterId: ROOT_CLUSTER_ID });
    expect(placeOf(ROOT_CLUSTER_ID, undefined, instance)).toMatchObject({ kind: 'unreachable', why: 'not-root' });
  });
});

describe('the cluster this Koala runs in', () => {
  it('is its machine\'s cluster, the system cluster\'s name where it was told no machine, and root\'s own on root', () => {
    expect(koalasClusterId(instance)).toBe('machine-dev1');
    expect(koalasClusterId({ root: false })).toBe('provisioning-lunorica');
    expect(koalasClusterId({ root: true })).toBeUndefined();
    expect(ownReach(instance)).toEqual({ clusterId: 'machine-dev1', kind: 'koala' });
    expect(ownReach({ root: false })).toEqual({ clusterId: 'provisioning-lunorica', kind: 'koala' });
    expect(ownReach({ root: true })).toEqual({ clusterId: ROOT_CLUSTER_ID, kind: 'root' });
  });

  it('is reached as Koala\'s own by that name where no machine was named, as a pool instance is, and nowhere else', () => {
    expect(placeOf('provisioning-lunorica', undefined, { root: false })).toEqual({ kind: 'koala', clusterId: 'provisioning-lunorica' });
    expect(placeOf('provisioning-lunorica', undefined, instance)).toMatchObject({ kind: 'unreachable', why: 'unknown' });
    expect(placeOf('provisioning-lunorica', undefined, { root: true })).toMatchObject({ kind: 'unreachable', why: 'unknown' });
  });
});

describe('what a workflow is handed to reach a cluster', () => {
  it('is the machine to start for a machine\'s cluster, Koala\'s own machine included, whatever state it is in', () => {
    expect(machineToStart('machine-dev2', machine({ status: 'stopped' }), instance)).toEqual({ deviceId: 'dev2' });
    expect(machineToStart('machine-dev1', undefined, instance)).toEqual({ deviceId: 'dev1' });
  });

  it('is no machine for a cluster that is not one, which is reached as it is', () => {
    expect(machineToStart('provisioning-lunorica', undefined, { root: false })).toBeUndefined();
    expect(machineToStart(ROOT_CLUSTER_ID, undefined, { root: true })).toBeUndefined();
    expect(machineToStart('old', { id: 'old', name: 'old', provider: 'k3d', status: 'healthy' }, instance)).toBeUndefined();
  });
});

describe('the kubeconfig a pod reaches its own cluster with', () => {
  it('is read from the service account Kubernetes mounts, and from nothing when the process is not in a pod', () => {
    expect(serviceAccountFrom({ KUBERNETES_SERVICE_HOST: '10.43.0.1', KUBERNETES_SERVICE_PORT: '443' }, '/sa')).toEqual({ host: '10.43.0.1', port: '443', caFile: '/sa/ca.crt', tokenFile: '/sa/token' });
    expect(serviceAccountFrom({}, '/sa')).toBeUndefined();
  });

  it('names the API server by its real address, with the account\'s CA and token file', () => {
    const kubeconfig = serviceAccountKubeconfig({ host: '10.43.0.1', port: '443', caFile: '/sa/ca.crt', tokenFile: '/sa/token' });
    expect(kubeconfig).toContain('server: https://10.43.0.1:443');
    expect(kubeconfig).toContain('certificate-authority: /sa/ca.crt');
    expect(kubeconfig).toContain('tokenFile: /sa/token');
    expect(kubeconfig).not.toContain('provisioning-lunorica');
  });

  it('brackets an IPv6 address', () => {
    expect(serviceAccountKubeconfig({ host: 'fd00::1', port: '443', caFile: 'c', tokenFile: 't' })).toContain('server: https://[fd00::1]:443');
  });
});
