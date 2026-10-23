import axios from 'axios';
import { afterEach, describe, expect, it } from 'vitest';
import { infrastructureRouter } from './infrastructure.js';
import { mountRouter, type Harness } from '../../platform/routes/test-harness.js';
import { InfrastructureViewService } from '../services/InfrastructureViewService.js';
import type { BrokenWorkload } from '../services/ClusterContentsService.js';
import type { KoalaView, Overview } from '../../monitoring/services/MonitoringService.js';
import type { WorkFailure } from '../lib/work-failures.js';

const monitoring: Overview = {
  attention: [{ subject: { kind: 'app', id: 'd1', name: 'Shop' }, state: 'down', reasons: ['it does not answer'] }],
  apps: [], clusters: [], firing: [], checkedAt: '2026-10-17T12:00:00Z',
};

const koala: KoalaView = {
  state: 'ok', reasons: [], numbers: { requestsPerSecond: 2.5, modelCallsPerMinute: 1 }, services: ['koala-backend', 'koala-worker-engine'],
  lines: ['Koala is healthy.', '2 processes report: koala-backend, koala-worker-engine.'], telemetry: { collector: true, tempo: true }, checkedAt: '2026-10-17T12:00:00Z',
};

const broken = (name: string, about: BrokenWorkload['about']): BrokenWorkload => ({
  namespace: 'ns', kind: 'Deployment', name, group: about.kind === 'app' ? 'apps' : 'other', about, pods: { total: 1, ready: 0 },
  state: 'down', reasons: ['it keeps crashing'], restarts: 4, clusterId: 'sys', clusterName: 'system',
});

const failure: WorkFailure = { id: 'run:r1', ownerId: 'u1', workflowId: 'r1', kind: 'chat', title: 'Koala answering in "Labels"', opens: { kind: 'chat', id: 'c1' }, reason: 'the model refused', failedAt: '2026-10-17T11:00:00Z' };

let harness: Harness;
afterEach(async () => { await harness.close(); });

async function app() {
  const cleared: Array<readonly string[] | 'all'> = [];
  const infrastructure = new InfrastructureViewService({
    monitoring: { overview: async () => monitoring, koala: async () => koala },
    contents: {
      broken: async () => [broken('shop-web', { kind: 'app', id: 'd1', name: 'Shop', mine: true }), broken('mystery', { kind: 'other' })],
      contents: async (_viewer, id) => ({ clusterId: id, readAt: 'now', reachable: true, ownsCluster: true, workloads: [], finishedJobs: 0, measured: true }),
    },
    running: {
      view: async () => ({ ok: true, value: {
        items: [
          { workflowId: 'release-p1', kind: 'release', title: 'Releasing Books: abc12345 waits for you on its card', since: 'then', opens: { kind: 'project', id: 'p1' }, cancel: { via: 'run', runId: 'release-p1~1' }, waitsFor: ['decide'] },
          { workflowId: 'run-r2', kind: 'chat', title: 'Koala answering', since: 'then', opens: { kind: 'chat', id: 'c2' }, cancel: { via: 'run', runId: 'run-r2' } },
        ],
        bench: { paused: true }, keeper: { paused: false, held: 0 },
      } }),
    },
    failures: { shown: async () => [failure], clear: async (_owner, ids) => { cleared.push(ids); return ids === 'all' ? 3 : ids.length; } },
  });
  harness = await mountRouter({ prefix: '/api/infrastructure', router: () => infrastructureRouter({ infrastructure }) });
  return { cleared };
}

describe('/api/infrastructure', () => {
  it('puts together what needs the person: health, broken workloads not already told by their app, work waiting on them, failures', async () => {
    await app();
    const res = await axios.get(harness.url('/api/infrastructure'));
    expect(res.data.workloads.map((workload: BrokenWorkload) => workload.name)).toEqual(['mystery']);
    expect(res.data.waiting.map((item: { workflowId: string }) => item.workflowId)).toEqual(['release-p1']);
    expect(res.data.running).toBe(2);
    expect(res.data.failures).toEqual([failure]);
    expect(res.data.monitoring.attention).toHaveLength(1);
    expect(res.data.koala).toEqual(koala);
  });

  it('reads one cluster', async () => {
    await app();
    const res = await axios.get(harness.url('/api/infrastructure/clusters/sys'));
    expect(res.data).toMatchObject({ clusterId: 'sys', reachable: true });
  });

  it('clears the failures named, or all of them, and refuses anything else', async () => {
    const { cleared } = await app();
    const clear = (body: unknown) => axios.post(harness.url('/api/infrastructure/failures/clear'), body);
    expect((await clear({ ids: ['run:r1'] })).data).toEqual({ cleared: 1 });
    expect((await clear({})).data).toEqual({ cleared: 3 });
    await expect(clear({ ids: 'run:r1' })).rejects.toMatchObject({ response: { status: 400 } });
    expect(cleared).toEqual([['run:r1'], 'all']);
  });
});
