import type { RequestHandler } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type WorkerService from '../services/WorkerService.js';
import { workerRouter } from './worker.js';
import { callRouter } from '../testing/call-router.js';

const open: RequestHandler = (_req, _res, next) => next();
const closed: RequestHandler = (_req, res) => { res.status(403).json({ error: 'only the operator' }); };

describe('/api/worker', () => {
  it('reports the worker as stopped when none has started', async () => {
    const workerService = mock<WorkerService>();
    workerService.status.mockReturnValue(null);
    const answer = await callRouter(workerRouter({ workerService, operatorOnly: open }), '/api/worker', {});
    expect(answer.body).toEqual({ clusterId: '', context: 'local', state: 'stopped', running: false });
  });

  it('reports the running worker\'s cluster and context', async () => {
    const workerService = mock<WorkerService>();
    workerService.status.mockReturnValue({ clusterId: 'c1', context: 'k3d-c1', state: 'running' });
    const answer = await callRouter(workerRouter({ workerService, operatorOnly: open }), '/api/worker', {});
    expect(answer.body).toEqual({ clusterId: 'c1', context: 'k3d-c1', state: 'running', running: true });
  });

  it('says what went wrong when the status cannot be read', async () => {
    const workerService = mock<WorkerService>();
    workerService.status.mockImplementation(() => { throw new Error('no worker service'); });
    const answer = await callRouter(workerRouter({ workerService, operatorOnly: open }), '/api/worker', {});
    expect(answer.status).toBe(500);
    expect(answer.body).toEqual({ error: 'no worker service' });
  });

  it('initializes a worker for the cluster named, and asks for one when none is', async () => {
    const router = workerRouter({ workerService: mock<WorkerService>(), operatorOnly: open });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const started = await callRouter(router, '/api/worker', { method: 'POST', body: { clusterId: 'c1', context: 'k3d-c1' } });
    expect(started.status).toBe(202);
    expect(started.body).toEqual({ message: 'Worker initialized', clusterId: 'c1', context: 'k3d-c1', state: 'running' });
    expect((await callRouter(router, '/api/worker', { method: 'POST', body: { clusterId: 'c2' } })).body).toMatchObject({ context: 'local' });
    log.mockRestore();
    const missing = await callRouter(router, '/api/worker', { method: 'POST', body: {} });
    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({ error: 'clusterId is required' });
  });

  it('stops the worker', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const answer = await callRouter(workerRouter({ workerService: mock<WorkerService>(), operatorOnly: open }), '/api/worker', { method: 'DELETE' });
    log.mockRestore();
    expect(answer.body).toEqual({ message: 'Worker stopped' });
  });

  it('lets only whoever the operator gate lets through start or stop it', async () => {
    const router = workerRouter({ workerService: mock<WorkerService>(), operatorOnly: closed });
    expect((await callRouter(router, '/api/worker', { method: 'POST', body: { clusterId: 'c1' } })).status).toBe(403);
    expect((await callRouter(router, '/api/worker', { method: 'DELETE' })).status).toBe(403);
  });
});
