import { describe, expect, it } from 'vitest';
import { koalaClusterMonitoring, machineMetricsUrl, metricsTokenManifests, monitoringPlan, monitoringStackEnv, monitoringStackName, placedOnPool, telemetryPresent } from './cluster-monitoring.js';

const operator = 'servicemonitors.monitoring.coreos.com\nprobes.monitoring.coreos.com\n';
const telemetry = { collector: true, tempo: true };

describe('monitoringPlan', () => {
  it('does nothing on a cluster that already has monitoring and Koala\'s own telemetry', () => {
    expect(monitoringPlan({ apiResources: operator, blackbox: true, ingressClasses: 'ingressclass.networking.k8s.io/traefik\n', telemetry }).stacks).toEqual([]);
  });

  it('applies the observability stack again when the collector or Tempo is missing, like a missing blackbox exporter', () => {
    expect(monitoringPlan({ apiResources: operator, blackbox: true, ingressClasses: '', telemetry: { collector: false, tempo: true } }).stacks).toEqual(['observability']);
    expect(monitoringPlan({ apiResources: operator, blackbox: true, ingressClasses: '', telemetry: { collector: true, tempo: false } }).stacks).toEqual(['observability']);
    expect(monitoringPlan({ apiResources: operator, blackbox: true, ingressClasses: '' }).stacks).toEqual(['observability']);
    expect(telemetryPresent(undefined)).toBe(false);
    expect(telemetryPresent(telemetry)).toBe(true);
  });

  it('gives a machine\'s cluster only the cluster stack, in agent mode, until it has the operator and its blackbox exporter, and no observability stack ever', () => {
    expect(monitoringPlan({ apiResources: '', blackbox: false, ingressClasses: '' }, false, true).stacks).toEqual(['cluster']);
    expect(monitoringPlan({ apiResources: operator, blackbox: false, ingressClasses: '' }, false, true).stacks).toEqual(['cluster']);
    expect(monitoringPlan({ apiResources: operator, blackbox: true, ingressClasses: '' }, false, true).stacks).toEqual([]);
  });

  it('installs both halves on a bare cluster, keeping the ingress it already has', () => {
    expect(monitoringPlan({ apiResources: '', blackbox: false, ingressClasses: 'ingressclass.networking.k8s.io/traefik\n' }))
      .toEqual({ stacks: ['cluster', 'observability'], keepIngress: true });
  });

  it('brings its own ingress to a cluster with none', () => {
    expect(monitoringPlan({ apiResources: '', blackbox: false, ingressClasses: '' }).keepIngress).toBe(false);
  });

  it('installs only the probes and alerts when the operator is there without them', () => {
    expect(monitoringPlan({ apiResources: operator, blackbox: false, ingressClasses: '', telemetry }).stacks).toEqual(['observability']);
  });

  it('installs the operator again when only the exporter survived', () => {
    expect(monitoringPlan({ apiResources: '', blackbox: true, ingressClasses: '' }).stacks).toEqual(['cluster', 'observability']);
  });
});

describe('monitoringStackEnv', () => {
  it('targets an existing cluster by its kubeconfig and keeps its ingress when asked', () => {
    expect(monitoringStackEnv({ physicalName: 'machine-desk', kubeconfigPath: '/tmp/kubeconfig-machine-desk' }, true)).toEqual({
      STACK_TYPE: 'cluster',
      CLUSTER_NAME: 'machine-desk',
      KUBECONFIG_PATH: '/tmp/kubeconfig-machine-desk',
      INGRESS_SERVICE: 'NodePort',
      CLUSTER_INGRESS: 'existing',
    });
  });

  it('names the two stacks the way provisioning does', () => {
    expect([monitoringStackName('c', 'cluster'), monitoringStackName('c', 'observability')]).toEqual(['c', 'c-observability']);
  });
});

describe('the cluster of a pool instance', () => {
  const seen = (apiResources: string, ingressClasses: string) => ({ apiResources, blackbox: false, ingressClasses });

  it('is watched by root, so it gets only the operator\'s resources and an ingress, never a monitoring stack of its own', () => {
    expect(monitoringPlan(seen('', ''), true)).toEqual({ stacks: ['cluster'], keepIngress: false });
    expect(monitoringPlan(seen('probes.monitoring.coreos.com', 'ingressclass.networking.k8s.io/traefik'), true)).toEqual({ stacks: [], keepIngress: true });
    expect(monitoringStackEnv({ physicalName: 'pool-bob', kubeconfigPath: '/k', pool: true }, false)).toMatchObject({ CLUSTER_MONITORING: 'crds', INGRESS_SERVICE: 'ClusterIP' });
    const machine = monitoringStackEnv({ physicalName: 'desk', kubeconfigPath: '/k', machine: { metricsUrl: 'http://100.64.0.7:30320/api/machines/metrics' } }, false);
    expect(machine).toMatchObject({ INGRESS_SERVICE: 'NodePort', CLUSTER_MONITORING: 'agent', REMOTE_WRITE_URL: 'http://100.64.0.7:30320/api/machines/metrics' });
    expect(machine).not.toHaveProperty('ENV');
    const kept = monitoringStackEnv({ physicalName: 'machine-desk', kubeconfigPath: '/k' }, false);
    expect(kept).toMatchObject({ INGRESS_SERVICE: 'NodePort' });
    expect(kept).not.toHaveProperty('CLUSTER_MONITORING');
    expect(kept).not.toHaveProperty('ENV');
    expect(monitoringStackEnv({ physicalName: 'desk', kubeconfigPath: '/k', koala: true }, false)).toMatchObject({ KOALA_CLUSTER: 'true', INGRESS_SERVICE: 'NodePort' });
  });

  it('is only the instance\'s own cluster, and only in pool mode', () => {
    expect(placedOnPool({ POOL: 'true' }, { kind: 'koala' })).toBe(true);
    expect(placedOnPool({ POOL: 'true' }, { kind: 'machine' })).toBe(false);
    expect(placedOnPool({}, { kind: 'koala' })).toBe(false);
  });
});

describe('the stacks that monitor Koala\'s own cluster, named for that cluster\'s id', () => {
  it('are applied with the same settings from the worker as from a deploy to the machine Koala runs on', () => {
    const koala = { clusterId: 'machine-desk', kind: 'koala' } as const;
    const worker = koalaClusterMonitoring({ INSTANCE_MACHINE_ID: 'desk' }, koala);
    const deploy = { physicalName: 'machine-desk', kubeconfigPath: '/k', pool: false, koala: true };
    expect(worker.reach).toBe(koala);
    expect(monitoringStackEnv({ ...worker, kubeconfigPath: '/k' }, true)).toEqual(monitoringStackEnv(deploy, true));
    expect(koalaClusterMonitoring({ POOL: 'true' }, koala)).toMatchObject({ pool: true, koala: true });
    expect(koalaClusterMonitoring({ POOL: 'true' }, { clusterId: 'pool-bob', kind: 'koala' })).toMatchObject({ physicalName: 'pool-bob', pool: true });
    expect(koalaClusterMonitoring({}, { clusterId: 'root', kind: 'root' })).toEqual({ physicalName: 'root', koala: true, pool: false, reach: { clusterId: 'root', kind: 'root' } });
  });
});

describe('where a machine\'s cluster sends its metrics', () => {
  it('is the instance\'s backend on its mesh address when the chart names it, otherwise this Koala\'s own address', () => {
    expect(machineMetricsUrl({ MACHINE_METRICS_URL: 'http://100.64.0.7:30320/api/machines/metrics', PUBLIC_URL: 'https://bo.koala.app' })).toBe('http://100.64.0.7:30320/api/machines/metrics');
    expect(machineMetricsUrl({ PUBLIC_URL: 'http://localhost:3001/' })).toBe('http://localhost:3001/api/machines/metrics');
  });

  it('is sent with a token kept in a Secret beside the agent, never in the stack', () => {
    expect(metricsTokenManifests('t0k')).toEqual([
      { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'monitoring' } },
      { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'koala-metrics', namespace: 'monitoring' }, type: 'Opaque', stringData: { token: 't0k' } },
    ]);
  });
});
