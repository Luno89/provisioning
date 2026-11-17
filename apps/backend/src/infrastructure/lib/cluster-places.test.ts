import { describe, expect, it } from 'vitest';
import { ROOT_CLUSTER_ID, appServiceType, hereFrom, koalasClusterId, machineToStart, ownReach, placedOnPool, placeOf, serviceAccountFrom, serviceAccountKubeconfig, type KnownCluster } from './cluster-places.js';

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
    expect(placeOf('old', machine({ id: 'old', name: 'old', provider: 'k3d' as never }), instance)).toMatchObject({ kind: 'unreachable', why: 'other-kind' });
    expect(placeOf('gone', undefined, instance)).toMatchObject({ kind: 'unreachable', why: 'unknown', reason: 'there is no cluster gone' });
  });

  it('reaches root\'s own cluster only on root', () => {
    expect(placeOf(ROOT_CLUSTER_ID, undefined, { root: true })).toEqual({ kind: 'root', clusterId: ROOT_CLUSTER_ID });
    expect(placeOf(ROOT_CLUSTER_ID, undefined, instance)).toMatchObject({ kind: 'unreachable', why: 'not-root' });
  });
});

describe('the cluster this Koala runs in', () => {
  it('is its machine\'s cluster, its place on Koala\'s servers for a pool instance, root\'s own on root, and none where it was told neither', () => {
    expect(koalasClusterId(instance)).toBe('machine-dev1');
    expect(koalasClusterId({ poolName: 'bob', root: false })).toBe('pool-bob');
    expect(koalasClusterId({ root: false })).toBeUndefined();
    expect(koalasClusterId({ root: true })).toBeUndefined();
    expect(ownReach(instance)).toEqual({ clusterId: 'machine-dev1', kind: 'koala' });
    expect(ownReach({ poolName: 'bob', root: false })).toEqual({ clusterId: 'pool-bob', kind: 'koala' });
    expect(ownReach({ root: false })).toBeUndefined();
    expect(ownReach({ root: true })).toEqual({ clusterId: ROOT_CLUSTER_ID, kind: 'root' });
  });

  it('is reached as Koala\'s own by the pool place\'s name only in that pool instance', () => {
    expect(placeOf('pool-bob', undefined, { poolName: 'bob', root: false })).toEqual({ kind: 'koala', clusterId: 'pool-bob' });
    expect(placeOf('pool-bob', undefined, instance)).toMatchObject({ kind: 'unreachable', why: 'unknown' });
    expect(placeOf('pool-bob', undefined, { root: true })).toMatchObject({ kind: 'unreachable', why: 'unknown' });
  });

  it('is read from the machine the chart names, or the pool place\'s name where the instance is on Koala\'s servers', () => {
    expect(hereFrom({ INSTANCE_MACHINE_ID: ' dev1 ', INSTANCE_NAME: 'bob' }, false)).toEqual({ koalaMachineId: 'dev1', poolName: undefined, root: false });
    expect(hereFrom({ POOL: 'true', INSTANCE_NAME: 'bob' }, false)).toEqual({ koalaMachineId: undefined, poolName: 'bob', root: false });
    expect(hereFrom({ INSTANCE_NAME: 'bob' }, false)).toEqual({ koalaMachineId: undefined, poolName: undefined, root: false });
    expect(hereFrom({}, true)).toEqual({ koalaMachineId: undefined, poolName: undefined, root: true });
  });
});

describe('what a workflow is handed to reach a cluster', () => {
  it('is the machine to start for a machine\'s cluster, Koala\'s own machine included, whatever state it is in', () => {
    expect(machineToStart('machine-dev2', machine({ status: 'stopped' }), instance)).toEqual({ deviceId: 'dev2' });
    expect(machineToStart('machine-dev1', undefined, instance)).toEqual({ deviceId: 'dev1' });
  });

  it('is no machine for a cluster that is not one, which is reached as it is', () => {
    expect(machineToStart('pool-bob', undefined, { poolName: 'bob', root: false })).toBeUndefined();
    expect(machineToStart(ROOT_CLUSTER_ID, undefined, { root: true })).toBeUndefined();
    expect(machineToStart('old', { id: 'old', name: 'old', provider: 'k3d' as never, status: 'healthy' }, instance)).toBeUndefined();
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
  });

  it('brackets an IPv6 address', () => {
    expect(serviceAccountKubeconfig({ host: 'fd00::1', port: '443', caFile: 'c', tokenFile: 't' })).toContain('server: https://[fd00::1]:443');
  });
});

describe('where an app on a cluster is placed', () => {
  it('is on the pool only on the instance\'s own cluster, and only in pool mode', () => {
    expect(placedOnPool(true, { kind: 'koala' })).toBe(true);
    expect(placedOnPool(true, { kind: 'machine' })).toBe(false);
    expect(placedOnPool(false, { kind: 'koala' })).toBe(false);
  });

  it('is reached by name on the pool and through a node port anywhere else', () => {
    expect(appServiceType(true)).toBe('ClusterIP');
    expect(appServiceType(false)).toBe('NodePort');
  });
});
