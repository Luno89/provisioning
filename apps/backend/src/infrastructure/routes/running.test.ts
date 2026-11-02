import { describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import type { RunningService, RunningView } from '../services/RunningService.js';
import { runningRouter } from './running.js';
import { callRouter, PERSON } from '../testing/call-router.js';

const view = { items: [], bench: { paused: false }, keeper: { paused: false, held: 0 } } as unknown as RunningView;

describe('/api/running', () => {
  it('shows what runs for the person asking', async () => {
    const running = mock<RunningService>();
    running.view.calledWith(PERSON.id).mockResolvedValue({ ok: true, value: view });
    expect((await callRouter(runningRouter({ running }), '/api/running', {})).body).toEqual(view);
  });

  it('cancels as the person asking, answering 202, and says why it cannot with the status given', async () => {
    const running = mock<RunningService>();
    running.cancel.calledWith(PERSON.id, 'run-1', PERSON.email).mockResolvedValue({ ok: true, value: { cancelling: true } as never });
    running.cancel.calledWith(PERSON.id, 'gone', PERSON.email).mockResolvedValue({ ok: false, status: 404, error: 'Nothing of yours is running under that id' });
    const router = runningRouter({ running });
    const cancelled = await callRouter(router, '/api/running', { method: 'POST', path: '/run-1/cancel', body: {} });
    expect(cancelled.status).toBe(202);
    expect(cancelled.body).toEqual({ cancelling: true });
    const missing = await callRouter(router, '/api/running', { method: 'POST', path: '/gone/cancel', body: {} });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Nothing of yours is running under that id' });
  });

  it('hands the bench and the memory keeper switches to the service as the person asking', async () => {
    const running = mock<RunningService>();
    running.pauseBench.calledWith(PERSON.id, matches<unknown>((body) => JSON.stringify(body) === '{"paused":true}')).mockResolvedValue({ ok: true, value: { paused: true } as never });
    running.pauseKeeper.calledWith(PERSON.id, matches<unknown>((body) => JSON.stringify(body) === '{"paused":false}')).mockResolvedValue({ ok: true, value: { paused: false, held: 0 } as never });
    const router = runningRouter({ running });
    expect((await callRouter(router, '/api/running', { method: 'PUT', path: '/bench', body: { paused: true } })).body).toEqual({ paused: true });
    expect((await callRouter(router, '/api/running', { method: 'PUT', path: '/keeper', body: { paused: false } })).body).toEqual({ paused: false, held: 0 });
  });
});
