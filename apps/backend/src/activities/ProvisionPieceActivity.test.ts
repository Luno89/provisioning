import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { PROVISION_PIECES } from '@koala/engine-core/koala-install';
import type { ClusterAccess, PieceChange, ProvisionPieceInput, Reach } from '../infrastructure/index.js';
import { openedRecord, PLATFORM_PLAN } from '../infrastructure/index.js';
import { MemoryInfrastructureStore } from '../infrastructure/testing/memory-store.js';
import type { ClusterSteps } from './cluster-steps.js';
import { installClusterMonitoring } from './cluster-monitoring.js';
import { provisionPlatformService } from './platform-provision.js';
import { ProvisionPieceActivity, recordedLines, type ProvisionLines, type ProvisionPlace } from './ProvisionPieceActivity.js';

vi.mock('./platform-provision.js', () => ({ provisionPlatformService: vi.fn() }));
vi.mock('./cluster-monitoring.js', async (actual) => ({ ...(await actual<typeof import('./cluster-monitoring.js')>()), installClusterMonitoring: vi.fn() }));

const OWN: Reach = { clusterId: 'machine-desk', kind: 'koala' };
const PLACE: ProvisionPlace = { koalaNamespace: 'nowrinkles', pool: false, dataDir: '/data', crawl4aiToken: 'crawlToken40' };

const input = (piece: ProvisionPieceInput['piece'], target: ProvisionPieceInput['target'] = { kind: 'koala', clusterId: 'machine-desk' }): ProvisionPieceInput => ({
  ownerId: 'owner-1', recordId: 'provision-machine-desk~1', target, revision: 3, piece,
});

function world() {
  const access = mock<ClusterAccess>();
  access.own.mockReturnValue(OWN);
  const steps = mock<ClusterSteps>({ access, machineMetricsUrl: 'http://100.64.0.7:30320/api/machines/metrics' });
  const heard: string[] = [];
  const lines: ProvisionLines = { heard: async (given, change) => { heard.push(`${given.piece} ${change.state}${'line' in change && change.line ? ` ${change.line}` : ''}`); } };
  return { steps, heard, lines };
}

beforeEach(() => { vi.mocked(provisionPlatformService).mockReset().mockResolvedValue(); vi.mocked(installClusterMonitoring).mockReset().mockResolvedValue(); });

describe('setting up one piece of a Koala', () => {
  it('applies that platform service on Koala\'s own cluster and tells the record only the lines the watch says while it works, in order, leaving the piece\'s start and end to its follower', async () => {
    const { steps, heard, lines } = world();
    vi.mocked(provisionPlatformService).mockImplementation(async (_steps, _place, _service, report) => {
      report('Gitea: applying; Terraform writes to /data/logs/platform-gitea.log');
      report('Gitea waits: statefulset/gitea in gitea: 0 of 1 ready');
    });
    await ProvisionPieceActivity(input('gitea'), { steps, place: PLACE, lines });
    expect(vi.mocked(provisionPlatformService).mock.calls[0]!.slice(1, 3)).toEqual([{ ...PLACE, reach: OWN }, PLATFORM_PLAN.find((service) => service.key === 'gitea')]);
    expect(heard).toEqual(['gitea started Gitea: applying; Terraform writes to /data/logs/platform-gitea.log', 'gitea started Gitea waits: statefulset/gitea in gitea: 0 of 1 ready']);
    expect(installClusterMonitoring).not.toHaveBeenCalled();
  });

  it('knows every platform piece the setup names, monitoring aside', () => {
    expect(PROVISION_PIECES.filter((piece) => piece.key !== 'monitoring').map((piece) => piece.key).sort()).toEqual(PLATFORM_PLAN.map((service) => service.key).sort());
  });

  it('installs the monitoring of Koala\'s own cluster with its own telemetry, telling the record what it installs', async () => {
    const { steps, heard, lines } = world();
    vi.mocked(installClusterMonitoring).mockImplementation(async (_steps, _cluster, said) => { said?.report?.('machine-desk has no monitoring yet; installing cluster and observability'); });
    await ProvisionPieceActivity(input('monitoring'), { steps, place: { ...PLACE, pool: true }, lines });
    expect(vi.mocked(installClusterMonitoring).mock.calls[0]![1]).toEqual({ physicalName: 'machine-desk', reach: OWN, pool: true, koala: true });
    expect(heard).toEqual(['monitoring started machine-desk has no monitoring yet; installing cluster and observability']);
    expect(provisionPlatformService).not.toHaveBeenCalled();
  });

  it('installs another machine\'s collector on that machine\'s cluster, sending to this Koala', async () => {
    const { steps, lines } = world();
    await ProvisionPieceActivity({ ...input('monitoring', { kind: 'machine', clusterId: 'machine-desk-2', machine: 'desk-2', deviceId: 'device-desk-2' }), kubeconfig: 'apiVersion: v1' }, { steps, place: PLACE, lines });
    expect(vi.mocked(installClusterMonitoring).mock.calls[0]![1]).toMatchObject({ physicalName: 'machine-desk-2', reach: { clusterId: 'machine-desk-2', kind: 'machine', kubeconfig: 'apiVersion: v1' }, pool: false, machine: { metricsUrl: 'http://100.64.0.7:30320/api/machines/metrics' } });
  });

  it('refuses another machine\'s collector when it was handed no way to reach that machine', async () => {
    const { steps, heard, lines } = world();
    await expect(ProvisionPieceActivity(input('monitoring', { kind: 'machine', clusterId: 'machine-desk-2', machine: 'desk-2', deviceId: 'device-desk-2' }), { steps, place: PLACE, lines })).rejects.toMatchObject({ nonRetryable: true, message: expect.stringContaining('machine-desk-2') as unknown });
    expect(installClusterMonitoring).not.toHaveBeenCalled();
    expect(heard).toEqual([]);
  });

  it('refuses a platform service on another machine, where only its collector is set up', async () => {
    const { steps, lines } = world();
    await expect(ProvisionPieceActivity({ ...input('gitea', { kind: 'machine', clusterId: 'machine-desk-2', machine: 'desk-2', deviceId: 'device-desk-2' }), kubeconfig: 'k' }, { steps, place: PLACE, lines })).rejects.toMatchObject({ nonRetryable: true, message: 'desk-2 gets only its collector set up, not Gitea, your repositories and images' });
    expect(provisionPlatformService).not.toHaveBeenCalled();
  });

  it('fails with why once what it applies can never come up, keeping every line it said before', async () => {
    const { steps, heard, lines } = world();
    vi.mocked(provisionPlatformService).mockImplementation(async (_steps, _place, _service, report) => {
      report('SearXNG: applying');
      throw new Error('SearXNG cannot finish: pods "x" is forbidden: exceeded quota: none');
    });
    await expect(ProvisionPieceActivity(input('searxng'), { steps, place: PLACE, lines })).rejects.toThrow('exceeded quota');
    expect(heard).toEqual(['searxng started SearXNG: applying']);
  });

  it('fails the piece when a line could not reach the record, after the work ends, with why', async () => {
    const { steps } = world();
    let calls = 0;
    const lines: ProvisionLines = { heard: async () => { calls += 1; if (calls === 1) throw new Error('the record could not be written'); } };
    vi.mocked(provisionPlatformService).mockImplementation(async (_steps, _place, _service, report) => { report('one'); report('two'); });
    await expect(ProvisionPieceActivity(input('verdaccio'), { steps, place: PLACE, lines })).rejects.toThrow('the record could not be written');
    expect(provisionPlatformService).toHaveBeenCalledTimes(1);
  });
});

describe('the lines a piece says, kept on its setup\'s record', () => {
  const at = () => '2026-11-18T10:00:00.000Z';

  it('mark the piece working with the latest line, leaving the rest of the run as it was', async () => {
    const store = new MemoryInfrastructureStore();
    const opened = openedRecord({ ownerId: 'owner-1', target: { kind: 'koala', clusterId: 'machine-desk' }, revision: 3, reason: 'revision', runId: 'provision-machine-desk~1', at: '2026-11-18T09:00:00.000Z' });
    await store.openProvisioning(opened);
    await store.patchProvisioning(opened.id, { workflowId: 'provision-machine-desk' });
    const lines = recordedLines(store, at);
    const change: PieceChange = { state: 'started', line: 'Gitea waits: statefulset/gitea in gitea: 0 of 1 ready' };
    await lines.heard(input('gitea'), change);
    const kept = await store.getProvisioningRun(opened.runId);
    expect(kept?.workflowId).toBe('provision-machine-desk');
    expect(kept?.state).toBe('running');
    expect(kept?.pieces.find((piece) => piece.key === 'gitea')).toEqual({ key: 'gitea', title: 'Gitea, your repositories and images', state: 'working', line: 'Gitea waits: statefulset/gitea in gitea: 0 of 1 ready', at: at() });
    expect(kept?.pieces.filter((piece) => piece.state === 'waiting')).toHaveLength(opened.pieces.length - 1);
  });

  it('refuse a line for a setup that has no record, naming it', async () => {
    const lines = recordedLines(new MemoryInfrastructureStore(), at);
    await expect(lines.heard(input('gitea'), { state: 'started' })).rejects.toThrow('the setup provision-machine-desk~1 has no record');
  });

  it('refuse a line for a setup that has ended, rather than writing over how it ended', async () => {
    const store = new MemoryInfrastructureStore();
    const opened = openedRecord({ ownerId: 'owner-1', target: { kind: 'koala', clusterId: 'machine-desk' }, revision: 3, reason: 'revision', runId: 'provision-machine-desk~1', at: '2026-11-18T09:00:00.000Z' });
    await store.openProvisioning(opened);
    await store.patchProvisioning(opened.id, { state: 'failed', why: 'the setup\'s run was stopped', endedAt: at() });
    await expect(recordedLines(store, at).heard(input('gitea'), { state: 'started', line: 'late' })).rejects.toMatchObject({ nonRetryable: true, message: 'the setup provision-machine-desk~1 has already ended failed, so what gitea says has nowhere to go' });
    expect((await store.getProvisioningRun(opened.id))?.pieces.find((piece) => piece.key === 'gitea')?.state).toBe('waiting');
  });
});
