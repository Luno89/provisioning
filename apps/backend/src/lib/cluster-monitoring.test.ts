import { describe, expect, it } from 'vitest';
import { monitoringPlan, monitoringStackEnv, monitoringStackName, placedOnPool, SYSTEM_CLUSTER } from './cluster-monitoring.js';

const operator = 'servicemonitors.monitoring.coreos.com\nprobes.monitoring.coreos.com\n';

describe('monitoringPlan', () => {
  it('does nothing on a cluster that already has monitoring', () => {
    expect(monitoringPlan({ apiResources: operator, blackbox: true, ingressClasses: 'ingressclass.networking.k8s.io/traefik\n' }).stacks).toEqual([]);
  });

  it('installs both halves on a bare cluster, keeping the ingress it already has', () => {
    expect(monitoringPlan({ apiResources: '', blackbox: false, ingressClasses: 'ingressclass.networking.k8s.io/traefik\n' }))
      .toEqual({ stacks: ['cluster', 'observability'], keepIngress: true });
  });

  it('brings its own ingress to a cluster with none', () => {
    expect(monitoringPlan({ apiResources: '', blackbox: false, ingressClasses: '' }).keepIngress).toBe(false);
  });

  it('installs only the probes and alerts when the operator is there without them', () => {
    expect(monitoringPlan({ apiResources: operator, blackbox: false, ingressClasses: '' }).stacks).toEqual(['observability']);
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
  });

  it('is only the instance\'s own cluster, and only in pool mode', () => {
    expect(placedOnPool({ POOL: 'true' }, SYSTEM_CLUSTER)).toBe(true);
    expect(placedOnPool({ POOL: 'true' }, 'shop-box')).toBe(false);
    expect(placedOnPool({}, SYSTEM_CLUSTER)).toBe(false);
  });
});
