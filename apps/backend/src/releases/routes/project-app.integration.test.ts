import { describe, it, expect, afterEach } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { authorize, type Principal } from '../../platform/lib/permissions.js';
import type { Database } from '../../platform/lib/db-interface.js';
import type { DeploymentMetadata } from '../../platform/lib/types.js';
import { ProjectAppService } from '../services/ProjectAppService.js';
import { projectAppRouter } from './project-app.js';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const ownedProject = (db: Database) => async (id: string, principal: Principal) => {
  const project = (await db.projects.getProjects()).find((entry) => entry.id === id);
  return project && authorize(principal, 'see', { kind: 'project', ownerId: project.ownerId }).allowed ? project : undefined;
};

const exposedAt = (mode: 'local' | 'public'): Partial<DeploymentMetadata> => (mode === 'local'
  ? { localExposureUrl: 'http://shop.localhost:8000' }
  : { publicExposureUrl: 'https://shop-x.example.com' });

const mount = async () => {
  const opened: string[] = [];
  h = await mountRouter({
    prefix: '/api/projects',
    router: (db) => projectAppRouter({
      apps: new ProjectAppService({
        deployments: () => db.infrastructure.getDeployments(),
        expose: async (deploymentId, mode) => {
          opened.push(mode);
          await db.infrastructure.saveDeploymentInfo({ id: deploymentId, ...exposedAt(mode) });
        },
      }),
      getOwnedProject: ownedProject(db),
    }),
  });
  await h.db.projects.saveProject({ id: 'p1', name: 'Shop', ownerId: TEST_USER.id, appType: 'gitapp', createdAt: 'then' });
  await h.db.projects.saveProject({ id: 'p2', name: 'Theirs', ownerId: 'someone-else', appType: 'gitapp', createdAt: 'then' });
  await h.db.infrastructure.saveDeploymentInfo({ id: 'd1', name: 'Shop', clusterId: 'c1', strategy: 'helm', appType: 'odoo-project', ownerId: TEST_USER.id, gitappProjectId: 'p1', status: 'running', createdAt: 'then' });
  await h.db.infrastructure.saveDeploymentInfo({ id: 'd2', name: 'Theirs', clusterId: 'c1', strategy: 'helm', appType: 'odoo-project', ownerId: 'someone-else', gitappProjectId: 'p2', status: 'running', createdAt: 'then' });
  return { harness: h, opened };
};

describe('a project\'s app', () => {
  it('says where it is, and opens it on this machine or publicly as asked', async () => {
    const { harness, opened } = await mount();
    expect((await axios.get(harness.url('/api/projects/p1/app'))).data).toEqual({ app: { id: 'd1', name: 'Shop', status: 'running', local: {}, public: {} } });
    expect((await axios.post<{ app: { local: { app?: string } } }>(harness.url('/api/projects/p1/app/open'), { mode: 'local' })).data.app.local.app).toBe('http://shop.localhost:8000');
    await axios.post(harness.url('/api/projects/p1/app/open'), { mode: 'public' });
    expect(opened).toEqual(['local', 'public']);
  });

  it('refuses a mode it does not know, and a project the person does not own', async () => {
    const { harness, opened } = await mount();
    expect((await axios.post(harness.url('/api/projects/p1/app/open'), { mode: 'everywhere' }, { validateStatus: () => true })).status).toBe(400);
    expect((await axios.post(harness.url('/api/projects/p2/app/open'), { mode: 'local' }, { validateStatus: () => true })).status).toBe(404);
    expect(opened).toEqual([]);
  });
});
