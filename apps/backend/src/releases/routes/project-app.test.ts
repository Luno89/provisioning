import { describe, expect, it } from 'vitest';
import { any, mock } from 'vitest-mock-extended';
import type { ProjectMetadata } from '../../platform/lib/types.js';
import type { ProjectApp } from '../lib/project-app.js';
import { routesInProcess } from '../../platform/testing/routes.js';
import { projectAppRouter, type ProjectAppRouterDeps } from './project-app.js';

const project = { id: 'p1', name: 'Shop' } as ProjectMetadata;
const app: ProjectApp = { id: 'd1', name: 'Shop', status: 'running', local: {}, public: {} };

async function setUp() {
  const apps = mock<ProjectAppRouterDeps['apps']>();
  const deps = mock<ProjectAppRouterDeps>({ apps });
  deps.getOwnedProject.calledWith('p1', any()).mockResolvedValue(project);
  deps.getOwnedProject.calledWith('p2', any()).mockResolvedValue(undefined);
  const routes = await routesInProcess({ prefix: '/', router: () => projectAppRouter(deps) });
  return { apps, routes };
}

describe('a project\'s app', () => {
  it('says where it is, and null before it has one', async () => {
    const { apps, routes } = await setUp();
    apps.app.mockResolvedValueOnce(app).mockResolvedValueOnce(undefined);
    expect((await routes.get('/p1/app')).data).toEqual({ app });
    expect((await routes.get('/p1/app')).data).toEqual({ app: null });
  });

  it('opens it on this machine or publicly as asked', async () => {
    const { apps, routes } = await setUp();
    const local = { ...app, local: { app: 'http://shop.localhost:8000' } };
    apps.open.calledWith(project, 'local').mockResolvedValue(local);
    apps.open.calledWith(project, 'public').mockResolvedValue({ ...app, public: { app: 'https://shop.dev' } });
    expect((await routes.post('/p1/app/open', { mode: 'local' })).data).toEqual({ app: local });
    expect((await routes.post('/p1/app/open', { mode: 'public' })).data).toEqual({ app: { ...app, public: { app: 'https://shop.dev' } } });
  });

  it('says why it could not be opened', async () => {
    const { apps, routes } = await setUp();
    apps.open.mockResolvedValue({ status: 409, error: 'the app is failed, not running, so there is nothing to open yet' });
    const refused = await routes.post('/p1/app/open', { mode: 'local' });
    expect([refused.status, refused.data]).toEqual([409, { error: 'the app is failed, not running, so there is nothing to open yet' }]);
  });

  it('refuses a mode it does not know, a missing body, and a project the person does not own', async () => {
    const { apps, routes } = await setUp();
    expect((await routes.post('/p1/app/open', { mode: 'everywhere' })).status).toBe(400);
    expect((await routes.post('/p1/app/open')).status).toBe(400);
    const other = await routes.post('/p2/app/open', { mode: 'local' });
    expect([other.status, other.data]).toEqual([404, { error: 'Project not found' }]);
    expect((await routes.get('/p2/app')).status).toBe(404);
    expect(apps.open).not.toHaveBeenCalled();
  });
});
