import { Router } from 'express';
import { describe, expect, it } from 'vitest';
import { workFor } from '@koala/engine-core/work-for';
import { memoryDatabase } from '../testing/memory-database.js';
import { routesInProcess } from '../testing/routes.js';
import { asyncRoute } from './async-route.js';
import { projectWork } from './project-work.js';

async function setUp(how?: Parameters<typeof projectWork>[2]) {
  const db = memoryDatabase();
  await db.projects.saveProject({ id: 'open', name: 'open', appType: 'gitapp', createdAt: 't' });
  await db.projects.saveProject({ id: 'going', name: 'going', appType: 'gitapp', createdAt: 't' });
  await db.projects.markDeleting('going', { startedAt: 't', requestedBy: 'u1', mode: 'permanent' });
  const ran: (string | undefined)[] = [];
  const router = Router();
  const named = projectWork(db.projects, async (req) => (req.params.id === 'none' ? undefined : String(req.params.id)), how);
  router.use('/:id', named);
  router.post('/:id', asyncRoute(async (_req, res) => { ran.push(workFor()?.project); res.json({ ok: true }); }));
  router.get('/:id', asyncRoute(async (_req, res) => { ran.push(workFor()?.project); res.json({ ok: true }); }));
  const routes = await routesInProcess({ prefix: '/', router: () => router, db });
  return { routes, ran };
}

describe('a request that acts on a project\'s things', () => {
  it('is refused with 409, in the words the person reads, while its project is being deleted, and does nothing', async () => {
    const { routes, ran } = await setUp();
    const answer = await routes.post('/going');
    expect(answer.status).toBe(409);
    expect(answer.data).toEqual({ error: 'this project is being deleted' });
    expect(ran).toEqual([]);
  });

  it('runs as work named for its project, so whatever it starts carries the project', async () => {
    const { routes, ran } = await setUp();
    expect((await routes.post('/open')).status).toBe(200);
    expect(ran).toEqual(['open']);
  });

  it('runs unnamed when it names no project', async () => {
    const { routes, ran } = await setUp();
    expect((await routes.post('/none')).status).toBe(200);
    expect(ran).toEqual([undefined]);
  });

  it('lets through a request that only stops or takes away, and a read', async () => {
    const stops = await setUp({ letThrough: ['POST /'] });
    expect((await stops.routes.post('/going')).status).toBe(200);
    const reads = await setUp();
    expect((await reads.routes.get('/going')).status).toBe(200);
  });

  it('answers 410 to a caller that is not a person, such as Gitea\'s webhook', async () => {
    const { routes } = await setUp({ gone: true });
    const answer = await routes.post('/going');
    expect(answer.status).toBe(410);
    expect(answer.data).toEqual({ error: 'this project is being deleted' });
  });
});
