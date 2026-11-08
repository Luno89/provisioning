import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ClusterAccess, InfrastructureService, Reach } from '../infrastructure/index.js';
import { metricsTokenHash } from '../machines/lib/machine-metrics.js';
import { koalaClusterMonitoring } from '../monitoring/lib/cluster-monitoring.js';
import { ensureClusterMonitoring } from './cluster-monitoring.js';

const PROBES = 'probes.monitoring.coreos.com\n';

const DESK: Reach = { clusterId: 'machine-desk', kind: 'machine', kubeconfig: 'apiVersion: v1' };
const OWN: Reach = { clusterId: 'machine-desk', kind: 'koala' };

function cluster(seen: { operator: boolean; blackbox: boolean }) {
  const access = mock<ClusterAccess>();
  const reached: Reach[] = [];
  access.kubectl.mockImplementation(async (target, args) => {
    reached.push(target as Reach);
    if (args[0] === 'api-resources') return seen.operator ? PROBES : '';
    if (args[0] === 'get' && args[1] === 'service') return args[2] === 'blackbox-exporter' && seen.blackbox ? 'service/blackbox-exporter' : '';
    return '';
  });
  access.apply.mockResolvedValue('');
  access.kubeconfigOf.mockImplementation(async (target) => `/clusters/kubeconfig-${(target as Reach).kind}`);
  const terraform = mock<InfrastructureService>();
  terraform.deploy.mockResolvedValue(undefined as never);
  return { access, infra: terraform, reached };
}

describe('monitoring a machine\'s cluster', () => {
  it('puts a token of its own in a Secret beside the collectors, keeps only its hash, and installs the agent stack that sends to this Koala', async () => {
    const steps = cluster({ operator: false, blackbox: false });
    const { access, infra } = steps;
    const kept: string[] = [];
    await ensureClusterMonitoring(steps, {
      physicalName: 'machine-desk', reach: DESK,
      machine: { metricsUrl: 'http://100.64.0.7:30320/api/machines/metrics', remember: async (hash) => { kept.push(hash); } },
    });
    expect(access.apply.mock.calls.map(([target]) => target)).toEqual([DESK, DESK]);
    expect(new Set(steps.reached)).toEqual(new Set([DESK]));
    const manifests = access.apply.mock.calls.map(([, manifest]) => JSON.parse(manifest) as { kind: string; stringData?: { token: string } });
    expect(manifests.map((manifest) => manifest.kind)).toEqual(['Namespace', 'Secret']);
    const token = manifests[1]!.stringData!.token;
    expect(kept).toEqual([metricsTokenHash(token)]);
    expect(infra.deploy.mock.calls.map(([name]) => name)).toEqual(['machine-desk']);
    expect(infra.deploy.mock.calls[0]![1]).toMatchObject({ env: { KUBECONFIG_PATH: '/clusters/kubeconfig-machine', CLUSTER_MONITORING: 'agent', REMOTE_WRITE_URL: 'http://100.64.0.7:30320/api/machines/metrics', INGRESS_SERVICE: 'NodePort' } });
    expect(JSON.stringify(infra.deploy.mock.calls)).not.toContain(token);
  });

  it('changes nothing on a machine whose collectors are already there', async () => {
    const steps = cluster({ operator: true, blackbox: true });
    await ensureClusterMonitoring(steps, { physicalName: 'machine-desk', reach: DESK, machine: { metricsUrl: 'u', remember: async () => { throw new Error('no token should be made'); } } });
    expect(steps.access.apply).not.toHaveBeenCalled();
    expect(steps.infra.deploy).not.toHaveBeenCalled();
  });

  it('gives any other cluster its whole stack, with no token', async () => {
    const steps = cluster({ operator: false, blackbox: false });
    await ensureClusterMonitoring(steps, { physicalName: 'shop-box', reach: DESK });
    expect(steps.access.apply).not.toHaveBeenCalled();
    expect(steps.infra.deploy.mock.calls.map(([name]) => name)).toEqual(['shop-box', 'shop-box-observability']);
  });
});

describe('monitoring Koala\'s own cluster', () => {
  const fromDeploy = { physicalName: 'machine-desk', reach: OWN, pool: false, koala: true };

  it('applies one set of stacks under one name, whether the worker starting or a deploy to the machine Koala runs on asks, and never twice at once', async () => {
    const steps = cluster({ operator: false, blackbox: false });
    const { infra } = steps;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    infra.deploy.mockImplementation(async () => { await gate; return undefined as never; });
    const worker = ensureClusterMonitoring(steps, koalaClusterMonitoring(false, OWN));
    const deploy = ensureClusterMonitoring(steps, fromDeploy);
    expect(deploy).toBe(worker);
    open();
    await Promise.all([worker, deploy]);
    expect(infra.deploy.mock.calls.map(([name]) => name)).toEqual(['machine-desk', 'machine-desk-observability']);
    expect(infra.deploy.mock.calls[0]![1]).toMatchObject({ env: { CLUSTER_NAME: 'machine-desk', KUBECONFIG_PATH: '/clusters/kubeconfig-koala', INGRESS_SERVICE: 'NodePort', KOALA_CLUSTER: 'true' } });
    expect(infra.deploy.mock.calls[0]![1]?.env).not.toHaveProperty('ENV');
  });

  it('keeps that name, the cluster\'s id, when only a deploy asks, so the stacks the worker applied stay the only ones', async () => {
    const steps = cluster({ operator: false, blackbox: false });
    await ensureClusterMonitoring(steps, fromDeploy);
    expect(steps.infra.deploy.mock.calls.map(([name]) => name)).toEqual(['machine-desk', 'machine-desk-observability']);
  });
});

describe('monitoring a cluster that cannot be reached', () => {
  it('installs nothing and fails with why the cluster could not be reached', async () => {
    const steps = cluster({ operator: false, blackbox: false });
    steps.access.kubectl.mockRejectedValue(new Error('machine-desk is stopped until something runs on it'));
    await expect(ensureClusterMonitoring(steps, { physicalName: 'stopped-desk', reach: DESK })).rejects.toThrow('stopped until something runs on it');
    expect(steps.infra.deploy).not.toHaveBeenCalled();
  });
});
