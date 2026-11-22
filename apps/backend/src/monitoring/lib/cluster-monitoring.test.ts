import { describe, expect, it } from 'vitest';
import { koalaClusterMonitoring, MONITORING_CHARTS, monitoringPlan, monitoringStackEnv, monitoringStackName, telemetryPresent } from './cluster-monitoring.js';

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
      .toEqual({ stacks: ['cluster', 'observability'], keepIngress: true, crdsFirst: false });
  });

  it('brings a stack at another version up to the one Koala pins, its operator\'s CRDs first, and the exporter on its own', () => {
    const pinned = { 'kube-prometheus-stack': `kube-prometheus-stack-${MONITORING_CHARTS.stack.version}`, 'blackbox-exporter': `prometheus-blackbox-exporter-${MONITORING_CHARTS.blackbox.version}` };
    const current = { apiResources: operator, blackbox: true, ingressClasses: '', telemetry };
    expect(monitoringPlan({ ...current, charts: pinned })).toEqual({ stacks: [], keepIngress: false, crdsFirst: false });
    expect(monitoringPlan({ ...current, charts: { ...pinned, 'kube-prometheus-stack': 'kube-prometheus-stack-88.6.2' } })).toEqual({ stacks: ['cluster'], keepIngress: false, crdsFirst: true });
    expect(monitoringPlan({ ...current, charts: { ...pinned, 'blackbox-exporter': 'prometheus-blackbox-exporter-11.18.0' } })).toEqual({ stacks: ['observability'], keepIngress: false, crdsFirst: false });
    expect(monitoringPlan({ ...current, charts: { ...pinned, 'kube-prometheus-stack': 'kube-prometheus-stack-88.6.2' } }, false, true)).toEqual({ stacks: ['cluster'], keepIngress: false, crdsFirst: true });
    expect(monitoringPlan({ ...current, charts: { ...pinned, 'blackbox-exporter': 'prometheus-blackbox-exporter-11.18.0' } }, false, true)).toEqual({ stacks: ['cluster'], keepIngress: false, crdsFirst: false });
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
    expect(monitoringPlan(seen('', ''), true)).toEqual({ stacks: ['cluster'], keepIngress: false, crdsFirst: false });
    expect(monitoringPlan(seen('probes.monitoring.coreos.com', 'ingressclass.networking.k8s.io/traefik'), true)).toEqual({ stacks: [], keepIngress: true, crdsFirst: false });
    expect(monitoringStackEnv({ physicalName: 'pool-bob', kubeconfigPath: '/k', pool: true }, false)).toMatchObject({ CLUSTER_MONITORING: 'crds', INGRESS_SERVICE: 'ClusterIP' });
    const machine = monitoringStackEnv({ physicalName: 'desk', kubeconfigPath: '/k', machine: { url: 'http://100.64.0.7:30320/api/machines/metrics', tokenUrl: 'https://koala.example/oidc/token', resource: 'urn:koala:instance:inst-1' } }, false);
    expect(machine).toMatchObject({
      INGRESS_SERVICE: 'NodePort', CLUSTER_MONITORING: 'agent',
      REMOTE_WRITE_URL: 'http://100.64.0.7:30320/api/machines/metrics', METRICS_TOKEN_URL: 'https://koala.example/oidc/token', METRICS_RESOURCE: 'urn:koala:instance:inst-1',
    });
    expect(machine).not.toHaveProperty('ENV');
    const kept = monitoringStackEnv({ physicalName: 'machine-desk', kubeconfigPath: '/k' }, false);
    expect(kept).toMatchObject({ INGRESS_SERVICE: 'NodePort' });
    expect(kept).not.toHaveProperty('CLUSTER_MONITORING');
    expect(kept).not.toHaveProperty('ENV');
    expect(monitoringStackEnv({ physicalName: 'desk', kubeconfigPath: '/k', koala: true }, false)).toMatchObject({ KOALA_CLUSTER: 'true', INGRESS_SERVICE: 'NodePort' });
  });

});

describe('the stacks that monitor Koala\'s own cluster, named for that cluster\'s id', () => {
  it('are applied with the same settings from the worker as from a deploy to the machine Koala runs on', () => {
    const koala = { clusterId: 'machine-desk', kind: 'koala' } as const;
    const worker = koalaClusterMonitoring(false, koala);
    const deploy = { physicalName: 'machine-desk', kubeconfigPath: '/k', pool: false, koala: true };
    expect(worker.reach).toBe(koala);
    expect(monitoringStackEnv({ ...worker, kubeconfigPath: '/k' }, true)).toEqual(monitoringStackEnv(deploy, true));
    expect(koalaClusterMonitoring(true, koala)).toMatchObject({ pool: true, koala: true });
    expect(koalaClusterMonitoring(true, { clusterId: 'pool-bob', kind: 'koala' })).toMatchObject({ physicalName: 'pool-bob', pool: true });
    expect(koalaClusterMonitoring(false, { clusterId: 'root', kind: 'root' })).toEqual({ physicalName: 'root', koala: true, pool: false, reach: { clusterId: 'root', kind: 'root' } });
  });
});
