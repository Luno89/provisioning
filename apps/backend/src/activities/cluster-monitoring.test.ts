import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ClusterAccess, InfrastructureService, Reach } from '../infrastructure/index.js';
import { ROLLOUT_KINDS } from '@koala/provision';
import { METRICS_CLIENT_SECRET } from '@koala/engine-core/root-client';
import { koalaClusterMonitoring, METRICS_SECRET_MISSING, MONITORING_CHARTS } from '../monitoring/lib/cluster-monitoring.js';
import { installClusterMonitoring } from './cluster-monitoring.js';

const PROBES = 'probes.monitoring.coreos.com\n';
const SENDING = { url: 'http://100.64.0.7:30320/api/machines/metrics', tokenUrl: 'https://koala.example/oidc/token', resource: 'urn:koala:instance:inst-1' };

const DESK: Reach = { clusterId: 'machine-desk', kind: 'machine', kubeconfig: 'apiVersion: v1' };
const OWN: Reach = { clusterId: 'machine-desk', kind: 'koala' };

function cluster(seen: { operator: boolean; blackbox: boolean; rolled?: (namespace: string) => unknown[]; charts?: Record<string, string>; telemetry?: boolean; namespaces?: string[]; metricsSecret?: false }) {
  const access = mock<ClusterAccess>();
  const reached: Reach[] = [];
  access.kubectl.mockImplementation(async (target, args) => {
    reached.push(target as Reach);
    if (args[0] === 'api-resources') return seen.operator ? PROBES : '';
    if (args[0] === 'get' && args[1] === 'service') return (args[2] === 'blackbox-exporter' && seen.blackbox) || (seen.telemetry && (args[2] === 'otel-collector' || args[2] === 'tempo')) ? `service/${args[2]}` : '';
    if (args[0] === 'get' && args[1] === 'namespaces') return JSON.stringify({ items: (seen.namespaces ?? ['default', 'kube-system']).map((name) => ({ apiVersion: 'v1', kind: 'Namespace', metadata: { name } })) });
    if (args[0] === 'get' && args[1] === 'secret') return seen.metricsSecret === false ? '' : `secret/${args[2]}`;
    if (args[0] === 'get' && args[1] === ROLLOUT_KINDS) return JSON.stringify({ items: seen.rolled?.(args[3]!) ?? [] });
    return '';
  });
  access.apply.mockResolvedValue('');
  access.helm.mockImplementation(async (_target, args) => {
    if (args[0] === 'list') return JSON.stringify(Object.entries(seen.charts ?? {}).map(([name, chart]) => ({ name, chart })));
    if (args[0] === 'show' && args[1] === 'crds') return `# the CRDs of ${args[2]} ${args[args.indexOf('--version') + 1]}`;
    return '';
  });
  access.kubeconfigOf.mockImplementation(async (target) => `/clusters/kubeconfig-${(target as Reach).kind}`);
  const terraform = mock<InfrastructureService>();
  terraform.deploy.mockResolvedValue(undefined as never);
  return { access, infra: terraform, reached };
}

describe('monitoring a machine\'s cluster', () => {
  it('installs the agent stack that sends to this Koala with a token its Prometheus takes from root, and makes or keeps no token of its own', async () => {
    const steps = cluster({ operator: false, blackbox: false });
    const { access, infra } = steps;
    await installClusterMonitoring(steps, { physicalName: 'machine-desk', reach: DESK, machine: SENDING });
    expect(access.apply).not.toHaveBeenCalled();
    expect(new Set(steps.reached)).toEqual(new Set([DESK]));
    expect(infra.deploy.mock.calls.map(([name]) => name)).toEqual(['machine-desk']);
    expect(infra.deploy.mock.calls[0]![1]).toMatchObject({
      env: {
        KUBECONFIG_PATH: '/clusters/kubeconfig-machine', CLUSTER_MONITORING: 'agent', INGRESS_SERVICE: 'NodePort',
        REMOTE_WRITE_URL: 'http://100.64.0.7:30320/api/machines/metrics', METRICS_TOKEN_URL: 'https://koala.example/oidc/token', METRICS_RESOURCE: 'urn:koala:instance:inst-1',
      },
    });
  });

  it('takes over the monitoring namespace the machine\'s agent made for its Secret, rather than making it again', async () => {
    const steps = cluster({ operator: false, blackbox: false, namespaces: ['default', 'kube-system', 'monitoring'] });
    await installClusterMonitoring(steps, { physicalName: 'machine-desk', reach: DESK, machine: SENDING });
    expect(JSON.parse(steps.infra.deploy.mock.calls[0]![1]!.env!.CLUSTER_EXISTING!)).toEqual(['v1/Namespace//monitoring']);
  });

  it('applies nothing while the Secret its Prometheus signs in to root with is not on the machine, saying why', async () => {
    const steps = cluster({ operator: false, blackbox: false, metricsSecret: false });
    await expect(installClusterMonitoring(steps, { physicalName: 'machine-desk', reach: DESK, machine: SENDING })).rejects.toThrow(METRICS_SECRET_MISSING('machine-desk'));
    expect(steps.access.kubectl).toHaveBeenCalledWith(DESK, ['get', 'secret', METRICS_CLIENT_SECRET.name, '-n', METRICS_CLIENT_SECRET.namespace, '--ignore-not-found', '-o', 'name']);
    expect(steps.infra.deploy).not.toHaveBeenCalled();
  });

  it('changes nothing on a machine whose collectors are already there', async () => {
    const steps = cluster({ operator: true, blackbox: true });
    await installClusterMonitoring(steps, { physicalName: 'machine-desk', reach: DESK, machine: SENDING });
    expect(steps.access.apply).not.toHaveBeenCalled();
    expect(steps.infra.deploy).not.toHaveBeenCalled();
  });

  it('gives any other cluster its whole stack, with no token', async () => {
    const steps = cluster({ operator: false, blackbox: false });
    await installClusterMonitoring(steps, { physicalName: 'shop-box', reach: DESK });
    expect(steps.access.apply).not.toHaveBeenCalled();
    expect(steps.infra.deploy.mock.calls.map(([name]) => name)).toEqual(['shop-box', 'shop-box-observability']);
  });
});

describe('a cluster whose monitoring is at another version than Koala pins', () => {
  it('applies the operator\'s CRDs of the pinned stack server-side, then upgrades only the stack that is behind', async () => {
    const steps = cluster({ operator: true, blackbox: true, telemetry: true, charts: { 'kube-prometheus-stack': 'kube-prometheus-stack-88.6.2', 'blackbox-exporter': `prometheus-blackbox-exporter-${MONITORING_CHARTS.blackbox.version}` } });
    const order: string[] = [];
    steps.access.apply.mockImplementation(async () => { order.push('crds'); return ''; });
    steps.infra.deploy.mockImplementation(async (name) => { order.push(`apply ${name}`); return undefined as never; });
    await installClusterMonitoring(steps, { physicalName: 'machine-desk', reach: OWN, pool: false, koala: true });
    expect(steps.access.helm).toHaveBeenCalledWith(OWN, ['show', 'crds', 'kube-prometheus-stack', '--repo', MONITORING_CHARTS.repo, '--version', MONITORING_CHARTS.stack.version]);
    expect(steps.access.apply).toHaveBeenCalledWith(OWN, `# the CRDs of kube-prometheus-stack ${MONITORING_CHARTS.stack.version}`, { serverSide: true });
    expect(order).toEqual(['crds', 'apply machine-desk']);
  });
});

describe('monitoring Koala\'s own cluster', () => {
  const fromDeploy = { physicalName: 'machine-desk', reach: OWN, pool: false, koala: true };

  it('keeps that name, the cluster\'s id, when only a deploy asks, so the stacks the worker applied stay the only ones', async () => {
    const steps = cluster({ operator: false, blackbox: false });
    await installClusterMonitoring(steps, fromDeploy);
    expect(steps.infra.deploy.mock.calls.map(([name]) => name)).toEqual(['machine-desk', 'machine-desk-observability']);
  });
});

describe('monitoring a cluster that cannot be reached', () => {
  it('installs nothing and fails with why the cluster could not be reached', async () => {
    const steps = cluster({ operator: false, blackbox: false });
    steps.access.kubectl.mockRejectedValue(new Error('machine-desk is stopped until something runs on it'));
    await expect(installClusterMonitoring(steps, { physicalName: 'stopped-desk', reach: DESK })).rejects.toThrow('stopped until something runs on it');
    expect(steps.infra.deploy).not.toHaveBeenCalled();
  });
});

describe('waiting for the monitoring to run', () => {
  const exporter = (available: number) => ({ kind: 'Deployment', metadata: { name: 'blackbox-exporter', generation: 1, annotations: { 'deployment.kubernetes.io/revision': '1' } }, spec: { replicas: 1 }, status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, availableReplicas: available } });
  const set = { kind: 'ReplicaSet', metadata: { name: 'blackbox-exporter-1', annotations: { 'deployment.kubernetes.io/revision': '1' }, ownerReferences: [{ kind: 'Deployment', name: 'blackbox-exporter' }] } };
  const pod = (state: Record<string, unknown>) => ({ kind: 'Pod', metadata: { name: 'blackbox-exporter-1-a', ownerReferences: [{ kind: 'ReplicaSet', name: 'blackbox-exporter-1' }] }, status: { phase: 'Running', containerStatuses: [{ name: 'c', ...state }] } });

  it('reads the namespaces each part installs into once Terraform is done, and ends when everything there has rolled out', async () => {
    let reads = 0;
    const steps = cluster({ operator: false, blackbox: false, rolled: (namespace) => (namespace === 'monitoring' && (reads += 1) < 3 ? [exporter(0), set, pod({ ready: false, state: { waiting: { reason: 'ContainerCreating' } } })] : [exporter(1), set, pod({ ready: true, state: { running: {} } })]) });
    await installClusterMonitoring(steps, { physicalName: 'shop-box', reach: DESK }, {}, async () => undefined);
    const watched = steps.access.kubectl.mock.calls.filter(([, args]) => args[1] === ROLLOUT_KINDS).map(([, args]) => args[3]);
    expect(new Set(watched)).toEqual(new Set(['monitoring', 'traefik']));
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  it('tells whoever follows it what it installs and each line the watch says while it waits', async () => {
    let reads = 0;
    const steps = cluster({ operator: false, blackbox: false, rolled: (namespace) => (namespace === 'monitoring' && (reads += 1) < 2 ? [exporter(0), set, pod({ ready: false, state: { waiting: { reason: 'ContainerCreating' } } })] : [exporter(1), set, pod({ ready: true, state: { running: {} } })]) });
    const told: string[] = [];
    await installClusterMonitoring(steps, koalaClusterMonitoring(false, OWN), { report: (line) => told.push(line) }, async () => undefined);
    expect(told[0]).toBe('machine-desk has no monitoring yet; installing cluster and observability');
    expect(told.filter((line) => line.startsWith('the monitoring of machine-desk waits: '))).toHaveLength(1);
  });

  it('fails the install, saying why, once something it made can never run', async () => {
    const steps = cluster({ operator: false, blackbox: false, rolled: (namespace) => (namespace === 'monitoring' ? [exporter(0), set, pod({ ready: false, state: { waiting: { reason: 'ImagePullBackOff' } } })] : []) });
    await expect(installClusterMonitoring(steps, { physicalName: 'shop-box', reach: DESK }, {}, async () => undefined))
      .rejects.toThrow('the monitoring of shop-box cannot finish: blackbox-exporter-1-a: ImagePullBackOff');
    expect(steps.infra.deploy.mock.calls.map(([name]) => name)).toEqual(['shop-box']);
  });
});
