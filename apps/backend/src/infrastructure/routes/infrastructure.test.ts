import type { Router } from 'express';
import { describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import type { Viewer } from '../../monitoring/index.js';
import type { InfrastructureOverview, InfrastructureViewService } from '../services/InfrastructureViewService.js';
import type { ClusterContents } from '../services/ClusterContentsService.js';
import { infrastructureRouter } from './infrastructure.js';
import { PERSON, routesInProcess } from '../../platform/testing/routes.js';

const on = (router: Router) => routesInProcess({ prefix: '/api/infrastructure', router: () => router, user: PERSON });

const asked = (viewer: Viewer): boolean => viewer.id === PERSON.id;

describe('/api/infrastructure', () => {
  it('shows the overview to the person asking', async () => {
    const infrastructure = mock<InfrastructureViewService>();
    const overview = { running: 2, failures: [] } as unknown as InfrastructureOverview;
    infrastructure.overview.calledWith(matches<Viewer>(asked)).mockResolvedValue(overview);
    expect((await (await on(infrastructureRouter({ infrastructure }))).get('/api/infrastructure')).data).toEqual(overview);
  });

  it('shows a cluster\'s contents to the person asking', async () => {
    const infrastructure = mock<InfrastructureViewService>();
    const contents = { workloads: [] } as unknown as ClusterContents;
    infrastructure.cluster.calledWith(matches<Viewer>(asked), 'c1').mockResolvedValue(contents);
    expect((await (await on(infrastructureRouter({ infrastructure }))).get('/api/infrastructure/clusters/c1')).data).toEqual(contents);
  });

  it('clears all failures when no ids are sent, only those named when some are, and refuses ids that are not text', async () => {
    const infrastructure = mock<InfrastructureViewService>();
    infrastructure.clearFailures.calledWith(matches<Viewer>(asked), 'all').mockResolvedValue(4);
    infrastructure.clearFailures.calledWith(matches<Viewer>(asked), matches<readonly string[] | 'all'>((ids) => Array.isArray(ids) && ids.join() === 'a,b')).mockResolvedValue(2);
    const router = infrastructureRouter({ infrastructure });
    expect((await (await on(router)).post('/api/infrastructure/failures/clear', {})).data).toEqual({ cleared: 4 });
    expect((await (await on(router)).post('/api/infrastructure/failures/clear', { ids: ['a', 'b'] })).data).toEqual({ cleared: 2 });
    const refused = await (await on(router)).post('/api/infrastructure/failures/clear', { ids: [1] });
    expect(refused.status).toBe(400);
    expect(refused.data).toEqual({ error: 'say which failures to clear as "ids", a list, or send none to clear them all' });
  });
});
