import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { InfrastructureService } from '../infrastructure/index.js';
import { metricsTokenHash } from '../machines/lib/machine-metrics.js';
import { koalaClusterMonitoring } from '../monitoring/lib/cluster-monitoring.js';
import { ensureClusterMonitoring } from './cluster-monitoring.js';

const PROBES = 'probes.monitoring.coreos.com\n';

function cluster(seen: { operator: boolean; blackbox: boolean }) {
  const infra = mock<InfrastructureService>();
  infra.runKubectl.mockImplementation(async (args) => {
    if (args[0] === 'api-resources') return seen.operator ? PROBES : '';
    if (args[0] === 'get' && args[1] === 'service') return args[2] === 'blackbox-exporter' && seen.blackbox ? 'service/blackbox-exporter' : '';
    return '';
  });
  infra.applyManifest.mockResolvedValue(undefined as never);
  infra.deploy.mockResolvedValue(undefined as never);
  return infra;
}

describe('monitoring a machine\'s cluster', () => {
  it('puts a token of its own in a Secret beside the collectors, keeps only its hash, and installs the agent stack that sends to this Koala', async () => {
    const infra = cluster({ operator: false, blackbox: false });
    const kept: string[] = [];
    await ensureClusterMonitoring(infra, {
      physicalName: 'machine-desk', kubeconfigPath: '/k', local: false,
      machine: { metricsUrl: 'http://100.64.0.7:30320/api/machines/metrics', remember: async (hash) => { kept.push(hash); } },
    });
    const manifests = infra.applyManifest.mock.calls.map(([manifest]) => JSON.parse(manifest) as { kind: string; stringData?: { token: string } });
    expect(manifests.map((manifest) => manifest.kind)).toEqual(['Namespace', 'Secret']);
    const token = manifests[1]!.stringData!.token;
    expect(kept).toEqual([metricsTokenHash(token)]);
    expect(infra.deploy.mock.calls.map(([name]) => name)).toEqual(['machine-desk']);
    expect(infra.deploy.mock.calls[0]![1]).toMatchObject({ env: { CLUSTER_MONITORING: 'agent', REMOTE_WRITE_URL: 'http://100.64.0.7:30320/api/machines/metrics', INGRESS_SERVICE: 'NodePort' } });
    expect(JSON.stringify(infra.deploy.mock.calls)).not.toContain(token);
  });

  it('changes nothing on a machine whose collectors are already there', async () => {
    const infra = cluster({ operator: true, blackbox: true });
    await ensureClusterMonitoring(infra, { physicalName: 'machine-desk', kubeconfigPath: '/k', local: false, machine: { metricsUrl: 'u', remember: async () => { throw new Error('no token should be made'); } } });
    expect(infra.applyManifest).not.toHaveBeenCalled();
    expect(infra.deploy).not.toHaveBeenCalled();
  });

  it('gives any other cluster its whole stack, with no token', async () => {
    const infra = cluster({ operator: false, blackbox: false });
    await ensureClusterMonitoring(infra, { physicalName: 'shop-box', kubeconfigPath: '/k', local: false });
    expect(infra.applyManifest).not.toHaveBeenCalled();
    expect(infra.deploy.mock.calls.map(([name]) => name)).toEqual(['shop-box', 'shop-box-observability']);
  });
});

describe('monitoring Koala\'s own cluster', () => {
  const fromDeploy = { physicalName: 'machine-desk', kubeconfigPath: '/tmp/handed-kubeconfig-desk', local: false, pool: false, nodePortIngress: true, koala: true };

  it('applies one set of stacks under one name, whether the worker starting or a deploy to the machine Koala runs on asks, and never twice at once', async () => {
    const infra = cluster({ operator: false, blackbox: false });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    infra.deploy.mockImplementation(async () => { await gate; return undefined as never; });
    const worker = ensureClusterMonitoring(infra, koalaClusterMonitoring({ INSTANCE_MACHINE_ID: 'desk' }, '/tmp/kubeconfig-provisioning-lunorica', true));
    const deploy = ensureClusterMonitoring(infra, fromDeploy);
    expect(deploy).toBe(worker);
    open();
    await Promise.all([worker, deploy]);
    expect(infra.deploy.mock.calls.map(([name]) => name)).toEqual(['provisioning-lunorica', 'provisioning-lunorica-observability']);
    expect(infra.deploy.mock.calls[0]![1]).toMatchObject({ env: { CLUSTER_NAME: 'provisioning-lunorica', INGRESS_SERVICE: 'NodePort', KOALA_CLUSTER: 'true' } });
  });

  it('keeps that name when only a deploy asks, so the stacks the worker applied stay the only ones', async () => {
    const infra = cluster({ operator: false, blackbox: false });
    await ensureClusterMonitoring(infra, fromDeploy);
    expect(infra.deploy.mock.calls.map(([name]) => name)).toEqual(['provisioning-lunorica', 'provisioning-lunorica-observability']);
  });
});
