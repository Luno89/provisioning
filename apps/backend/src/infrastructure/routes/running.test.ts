import type { Router } from 'express';
import { describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import type { RunningService, RunningView } from '../services/RunningService.js';
import { runningRouter } from './running.js';
import { PERSON, routesInProcess } from '../../platform/testing/routes.js';

const on = (router: Router) => routesInProcess({ prefix: '/api/running', router: () => router, user: PERSON });

const view = { items: [], bench: { paused: false }, keeper: { paused: false, held: 0 } } as unknown as RunningView;

describe('/api/running', () => {
  it('shows what runs for the person asking', async () => {
    const running = mock<RunningService>();
    running.view.calledWith(PERSON.id).mockResolvedValue({ ok: true, value: view });
    expect((await (await on(runningRouter({ running }))).get('/api/running')).data).toEqual(view);
  });

  it('cancels as the person asking, answering 202, and says why it cannot with the status given', async () => {
    const running = mock<RunningService>();
    running.cancel.calledWith(PERSON.id, 'run-1', PERSON.email).mockResolvedValue({ ok: true, value: { cancelling: true } as never });
    running.cancel.calledWith(PERSON.id, 'gone', PERSON.email).mockResolvedValue({ ok: false, status: 404, error: 'Nothing of yours is running under that id' });
    const router = runningRouter({ running });
    const cancelled = await (await on(router)).post('/api/running/run-1/cancel', {});
    expect(cancelled.status).toBe(202);
    expect(cancelled.data).toEqual({ cancelling: true });
    const missing = await (await on(router)).post('/api/running/gone/cancel', {});
    expect(missing.status).toBe(404);
    expect(missing.data).toEqual({ error: 'Nothing of yours is running under that id' });
  });

  it('hands the bench and the memory keeper switches to the service as the person asking', async () => {
    const running = mock<RunningService>();
    running.pauseBench.calledWith(PERSON.id, matches<unknown>((body) => JSON.stringify(body) === '{"paused":true}')).mockResolvedValue({ ok: true, value: { paused: true } as never });
    running.pauseKeeper.calledWith(PERSON.id, matches<unknown>((body) => JSON.stringify(body) === '{"paused":false}')).mockResolvedValue({ ok: true, value: { paused: false, held: 0 } as never });
    const router = runningRouter({ running });
    expect((await (await on(router)).put('/api/running/bench', { paused: true })).data).toEqual({ paused: true });
    expect((await (await on(router)).put('/api/running/keeper', { paused: false })).data).toEqual({ paused: false, held: 0 });
  });
});
