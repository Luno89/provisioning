import type { RequestHandler, Router } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type WorkerService from '../services/WorkerService.js';
import { workerRouter } from './worker.js';
import { PERSON, routesInProcess } from '../../platform/testing/routes.js';

const on = (router: Router) => routesInProcess({ prefix: '/api/worker', router: () => router, user: PERSON });

const open: RequestHandler = (_req, _res, next) => next();
const closed: RequestHandler = (_req, res) => { res.status(403).json({ error: 'only the operator' }); };

describe('/api/worker', () => {
  it('reports the worker as stopped when none has started', async () => {
    const workerService = mock<WorkerService>();
    workerService.status.mockReturnValue(null);
    const answer = await (await on(workerRouter({ workerService, operatorOnly: open }))).get('/api/worker');
    expect(answer.data).toEqual({ clusterId: '', context: 'local', state: 'stopped', running: false });
  });

  it('reports the running worker\'s cluster and context', async () => {
    const workerService = mock<WorkerService>();
    workerService.status.mockReturnValue({ clusterId: 'c1', context: 'k3d-c1', state: 'running' });
    const answer = await (await on(workerRouter({ workerService, operatorOnly: open }))).get('/api/worker');
    expect(answer.data).toEqual({ clusterId: 'c1', context: 'k3d-c1', state: 'running', running: true });
  });

  it('says what went wrong when the status cannot be read', async () => {
    const workerService = mock<WorkerService>();
    workerService.status.mockImplementation(() => { throw new Error('no worker service'); });
    const answer = await (await on(workerRouter({ workerService, operatorOnly: open }))).get('/api/worker');
    expect(answer.status).toBe(500);
    expect(answer.data).toEqual({ error: 'no worker service' });
  });

  it('initializes a worker for the cluster named, and asks for one when none is', async () => {
    const router = workerRouter({ workerService: mock<WorkerService>(), operatorOnly: open });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const started = await (await on(router)).post('/api/worker', { clusterId: 'c1', context: 'k3d-c1' });
    expect(started.status).toBe(202);
    expect(started.data).toEqual({ message: 'Worker initialized', clusterId: 'c1', context: 'k3d-c1', state: 'running' });
    expect((await (await on(router)).post('/api/worker', { clusterId: 'c2' })).data).toMatchObject({ context: 'local' });
    log.mockRestore();
    const missing = await (await on(router)).post('/api/worker', {});
    expect(missing.status).toBe(400);
    expect(missing.data).toEqual({ error: 'clusterId is required' });
  });

  it('stops the worker', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const answer = await (await on(workerRouter({ workerService: mock<WorkerService>(), operatorOnly: open }))).delete('/api/worker');
    log.mockRestore();
    expect(answer.data).toEqual({ message: 'Worker stopped' });
  });

  it('lets only whoever the operator gate lets through start or stop it', async () => {
    const router = workerRouter({ workerService: mock<WorkerService>(), operatorOnly: closed });
    expect((await (await on(router)).post('/api/worker', { clusterId: 'c1' })).status).toBe(403);
    expect((await (await on(router)).delete('/api/worker')).status).toBe(403);
  });
});
