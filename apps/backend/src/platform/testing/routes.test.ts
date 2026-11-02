import { Router } from 'express';
import { describe, expect, it } from 'vitest';
import { asyncRoute } from '../middleware/async-route.js';
import { routesInProcess } from './routes.js';

const router = () => {
  const routes = Router();
  routes.get('/me', (req, res) => { res.json({ id: (req as unknown as { user: { id: string } }).user.id }); });
  routes.post('/echo', (req, res) => { res.status(201).json({ got: req.body as unknown }); });
  routes.get('/boom', asyncRoute(async () => { throw new Error('it broke'); }));
  return routes;
};

describe('a router run in process, as a unit test runs one', () => {
  it('answers through the same app the integration harness mounts, as the signed-in person, with nothing listening', async () => {
    const routes = await routesInProcess({ prefix: '/api/things', router });
    expect(await routes.get('/api/things/me')).toMatchObject({ status: 200, data: { id: 'test-user' } });
    expect(await routes.post('/api/things/echo', { a: 1 })).toMatchObject({ status: 201, data: { got: { a: 1 } } });
    expect((await routes.get('/api/things/boom')).status).toBe(500);
  });

  it('refuses a request with no one signed in, as the harness does', async () => {
    const routes = await routesInProcess({ prefix: '/api/things', router, user: null });
    expect(await routes.get('/api/things/me')).toMatchObject({ status: 401, data: { error: 'Session missing' } });
  });
});
