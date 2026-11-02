import { Router } from 'express';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { asyncRoute } from '../middleware/async-route.js';
import { OPERATOR, PERSON, routesInProcess } from './routes.js';

const taken = (stream: Readable): Promise<Buffer> => new Promise((resolve, reject) => {
  const parts: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => parts.push(chunk));
  stream.on('end', () => resolve(Buffer.concat(parts)));
  stream.on('error', reject);
});

const router = () => {
  const routes = Router();
  routes.get('/me', (req, res) => { res.json({ id: (req as unknown as { user: { id: string } }).user.id }); });
  routes.get('/who', (req, res) => {
    const user = (req as unknown as { user?: { id: string; roles?: string[] } }).user;
    res.json(user ? { id: user.id, roles: user.roles ?? [] } : { id: null });
  });
  routes.post('/echo', (req, res) => { res.status(201).json({ got: req.body as unknown }); });
  routes.get('/boom', asyncRoute(async () => { throw new Error('it broke'); }));
  routes.get('/header', (req, res) => { res.json({ seen: req.headers['x-seen'] ?? null }); });
  routes.put('/upload', asyncRoute(async (req, res) => {
    const bytes = await taken(req);
    res.json({ size: bytes.length, type: req.headers['content-type'] ?? null, chunked: req.headers['transfer-encoding'] === 'chunked', hex: bytes.toString('hex') });
  }));
  routes.get('/download', (_req, res) => {
    res.setHeader('Content-Type', 'application/octet-stream');
    Readable.from([Buffer.from([0, 255, 128]), Buffer.from([1, 2])]).pipe(res);
  });
  routes.get('/wait', asyncRoute(async (_req, res) => {
    await new Promise<void>((resolve) => res.on('close', () => resolve()));
    res.status(204).end();
  }));
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

  it('lets a signed-out request reach the router when the routes are open, with no one on it', async () => {
    const routes = await routesInProcess({ prefix: '/api/things', router, user: null, open: true });
    expect(await routes.get('/api/things/who')).toMatchObject({ status: 200, data: { id: null } });
    expect(await routes.get('/api/things/who', { user: OPERATOR })).toMatchObject({ data: { id: 'operator-1', roles: ['operator'] } });
  });
});

describe('what a request can carry', () => {
  it('is made as another person for one request and leaves the signed-in one alone', async () => {
    const routes = await routesInProcess({ prefix: '/api/things', router, user: PERSON });
    expect((await routes.get('/api/things/me', { user: OPERATOR })).data).toEqual({ id: 'operator-1' });
    expect((await routes.get('/api/things/me')).data).toEqual({ id: 'person-1' });
    expect((await routes.get('/api/things/me', { user: null })).status).toBe(401);
    routes.setUser(OPERATOR);
    expect((await routes.get('/api/things/me')).data).toEqual({ id: 'operator-1' });
  });

  it('sends its headers', async () => {
    const routes = await routesInProcess({ prefix: '/api/things', router });
    expect((await routes.get('/api/things/header', { headers: { 'x-seen': 'yes' } })).data).toEqual({ seen: 'yes' });
    expect((await routes.get('/api/things/header')).data).toEqual({ seen: null });
  });

  it('sends raw bytes as they are, with the type it names', async () => {
    const routes = await routesInProcess({ prefix: '/api/things', router });
    const answer = await routes.put<{ size: number; type: string; hex: string }>('/api/things/upload', undefined, { raw: Buffer.from([0, 255, 128, 7]), headers: { 'content-type': 'application/octet-stream' } });
    expect(answer.data).toEqual({ size: 4, type: 'application/octet-stream', chunked: false, hex: '00ff8007' });
  });

  it('sends text as it is, without making it JSON', async () => {
    const routes = await routesInProcess({ prefix: '/api/things', router });
    const answer = await routes.put<{ size: number; type: string | null; hex: string }>('/api/things/upload', undefined, { raw: 'logout_token=good', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(answer.data).toMatchObject({ size: 17, type: 'application/x-www-form-urlencoded' });
  });

  it('streams a body it is given as a stream', async () => {
    const routes = await routesInProcess({ prefix: '/api/things', router });
    const answer = await routes.put<{ size: number; chunked: boolean; hex: string }>('/api/things/upload', undefined, { raw: Readable.from([Buffer.from([1, 2]), Buffer.from([3])]), headers: { 'content-type': 'application/octet-stream' } });
    expect(answer.data).toMatchObject({ size: 3, chunked: true, hex: '010203' });
  });

  it('reads a streamed answer whole, as bytes', async () => {
    const routes = await routesInProcess({ prefix: '/api/things', router });
    const answer = await routes.get('/api/things/download');
    expect(answer.status).toBe(200);
    expect(answer.headers['content-type']).toBe('application/octet-stream');
    expect([...answer.bytes]).toEqual([0, 255, 128, 1, 2]);
  });

  it('hangs up while the router waits, which the router hears as its connection closing', async () => {
    const routes = await routesInProcess({ prefix: '/api/things', router });
    const answer = await routes.get('/api/things/wait', { hangUp: Promise.resolve() });
    expect([answer.status, answer.text]).toEqual([204, '']);
  });
});
