import { describe, expect, it } from 'vitest';
import { any, mock } from 'vitest-mock-extended';
import type { ProjectMetadata } from '../../platform/lib/types.js';
import type { ProjectApp } from '../lib/project-app.js';
import { dispatch } from '../testing/dispatch.js';
import { projectAppRouter, type ProjectAppRouterDeps } from './project-app.js';

const project = { id: 'p1', name: 'Shop' } as ProjectMetadata;
const app: ProjectApp = { id: 'd1', name: 'Shop', status: 'running', local: {}, public: {} };

function setUp() {
  const apps = mock<ProjectAppRouterDeps['apps']>();
  const deps = mock<ProjectAppRouterDeps>({ apps });
  deps.getOwnedProject.calledWith('p1', any()).mockResolvedValue(project);
  deps.getOwnedProject.calledWith('p2', any()).mockResolvedValue(undefined);
  return { apps, router: projectAppRouter(deps) };
}

describe('a project\'s app', () => {
  it('says where it is, and null before it has one', async () => {
    const { apps, router } = setUp();
    apps.app.mockResolvedValueOnce(app).mockResolvedValueOnce(undefined);
    expect((await dispatch(router, { method: 'GET', url: '/p1/app' })).json).toEqual({ app });
    expect((await dispatch(router, { method: 'GET', url: '/p1/app' })).json).toEqual({ app: null });
  });

  it('opens it on this machine or publicly as asked', async () => {
    const { apps, router } = setUp();
    const local = { ...app, local: { app: 'http://shop.localhost:8000' } };
    apps.open.calledWith(project, 'local').mockResolvedValue(local);
    apps.open.calledWith(project, 'public').mockResolvedValue({ ...app, public: { app: 'https://shop.dev' } });
    expect((await dispatch(router, { method: 'POST', url: '/p1/app/open', json: { mode: 'local' } })).json).toEqual({ app: local });
    expect((await dispatch(router, { method: 'POST', url: '/p1/app/open', json: { mode: 'public' } })).json).toEqual({ app: { ...app, public: { app: 'https://shop.dev' } } });
  });

  it('says why it could not be opened', async () => {
    const { apps, router } = setUp();
    apps.open.mockResolvedValue({ status: 409, error: 'the app is failed, not running, so there is nothing to open yet' });
    const refused = await dispatch(router, { method: 'POST', url: '/p1/app/open', json: { mode: 'local' } });
    expect([refused.status, refused.json]).toEqual([409, { error: 'the app is failed, not running, so there is nothing to open yet' }]);
  });

  it('refuses a mode it does not know, a missing body, and a project the person does not own', async () => {
    const { apps, router } = setUp();
    expect((await dispatch(router, { method: 'POST', url: '/p1/app/open', json: { mode: 'everywhere' } })).status).toBe(400);
    expect((await dispatch(router, { method: 'POST', url: '/p1/app/open' })).status).toBe(400);
    const other = await dispatch(router, { method: 'POST', url: '/p2/app/open', json: { mode: 'local' } });
    expect([other.status, other.json]).toEqual([404, { error: 'Project not found' }]);
    expect((await dispatch(router, { method: 'GET', url: '/p2/app' })).status).toBe(404);
    expect(apps.open).not.toHaveBeenCalled();
  });
});
