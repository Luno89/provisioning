import { describe, expect, it } from 'vitest';
import { koalaClusterMonitoring, machineMetricsUrl, metricsTokenManifests, monitoringOwner, monitoringPlan, monitoringStackEnv, monitoringStackName, placedOnPool, SYSTEM_CLUSTER, telemetryPresent } from './cluster-monitoring.js';

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
    expect(monitoringStackEnv({ physicalName: 'provisioning-lunorica', kubeconfigPath: '/tmp/kubeconfig-provisioning-lunorica', local: false }, true)).toEqual({
      STACK_TYPE: 'cluster',
      ENV: 'remote',
      CLUSTER_NAME: 'provisioning-lunorica',
      KUBECONFIG_PATH: '/tmp/kubeconfig-provisioning-lunorica',
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
    expect(monitoringStackEnv({ physicalName: SYSTEM_CLUSTER, kubeconfigPath: '/k', local: false, pool: true }, false)).toMatchObject({ CLUSTER_MONITORING: 'crds', INGRESS_SERVICE: 'ClusterIP' });
    expect(monitoringStackEnv({ physicalName: 'desk', kubeconfigPath: '/k', local: false, machine: { metricsUrl: 'http://100.64.0.7:30320/api/machines/metrics' } }, false))
      .toMatchObject({ ENV: 'remote', INGRESS_SERVICE: 'NodePort', CLUSTER_MONITORING: 'agent', REMOTE_WRITE_URL: 'http://100.64.0.7:30320/api/machines/metrics' });
    expect(monitoringStackEnv({ physicalName: 'hetzner-a', kubeconfigPath: '/k', local: false }, false)).not.toHaveProperty('INGRESS_SERVICE');
    const kept = monitoringStackEnv({ physicalName: SYSTEM_CLUSTER, kubeconfigPath: '/k', local: false, nodePortIngress: true }, false);
    expect(kept).toMatchObject({ INGRESS_SERVICE: 'NodePort' });
    expect(kept).not.toHaveProperty('CLUSTER_MONITORING');
    expect(monitoringStackEnv({ physicalName: 'desk', kubeconfigPath: '/k', local: false, nodePortIngress: true, koala: true }, false)).toMatchObject({ KOALA_CLUSTER: 'true', INGRESS_SERVICE: 'NodePort' });
  });

  it('is only the instance\'s own cluster, and only in pool mode', () => {
    expect(placedOnPool({ POOL: 'true' }, SYSTEM_CLUSTER)).toBe(true);
    expect(placedOnPool({ POOL: 'true' }, 'shop-box')).toBe(false);
    expect(placedOnPool({}, SYSTEM_CLUSTER)).toBe(false);
  });
});

describe('the stacks that monitor Koala\'s own cluster', () => {
  it('are named for the system cluster however Koala reaches it, and any other cluster\'s for itself', () => {
    expect(monitoringOwner({ physicalName: 'machine-desk', koala: true })).toBe(SYSTEM_CLUSTER);
    expect(monitoringOwner({ physicalName: SYSTEM_CLUSTER, koala: true })).toBe(SYSTEM_CLUSTER);
    expect(monitoringOwner({ physicalName: 'machine-desk' })).toBe('machine-desk');
  });

  it('are applied with the same settings from the worker as from a deploy to the machine Koala runs on', () => {
    const koala = { clusterId: 'machine-desk', kind: 'koala' } as const;
    const worker = koalaClusterMonitoring({ INSTANCE_MACHINE_ID: 'desk' }, koala, true);
    const deploy = { physicalName: monitoringOwner({ physicalName: 'machine-desk', koala: true }), kubeconfigPath: '/k', local: false, pool: false, nodePortIngress: true, koala: true };
    expect(worker.reach).toBe(koala);
    expect(monitoringStackEnv({ ...worker, kubeconfigPath: '/k' }, true)).toEqual(monitoringStackEnv(deploy, true));
    expect(koalaClusterMonitoring({ POOL: 'true' }, koala, true)).toMatchObject({ pool: true, nodePortIngress: false, local: false });
    expect(koalaClusterMonitoring({}, { clusterId: 'root', kind: 'root' }, false)).toMatchObject({ physicalName: SYSTEM_CLUSTER, local: true, koala: true, reach: { kind: 'root' } });
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
