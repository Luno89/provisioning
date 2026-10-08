import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import { projectsRouter } from './projects.js';
import { ProjectRemovalService, type ProjectRemovalState } from '../services/ProjectRemovalService.js';

let harness: Harness;
let started: string[];
let states: Map<string, ProjectRemovalState>;

beforeEach(async () => {
  started = [];
  states = new Map();
  harness = await mountRouter({
    prefix: '/api/projects',
    router: async (db) => {
      await db.saveProject({ id: 'p1', name: 'shop', ownerId: TEST_USER.id, giteaOwner: 'koala-t', giteaRepo: 'shop', appType: 'gitapp', createdAt: 'then' });
      await db.saveProject({ id: 'p2', name: 'theirs', ownerId: 'someone-else', appType: 'gitapp', createdAt: 'then' });
      await db.saveTree({ id: 't1', ownerId: TEST_USER.id, name: 'Shop features', type: 'software', projectIds: ['p1'], createdAt: 'then', updatedAt: 'then' } as never);
      const removal = new ProjectRemovalService({
        store: db,
        now: () => 'now',
        workflows: {
          start: async (_type, workflowId) => { started.push(workflowId); states.set(workflowId, { state: 'running', done: [] }); },
          state: async (workflowId) => states.get(workflowId) ?? { state: 'none' },
        },
      });
      return projectsRouter({ db, removal, getOwnedProject: async () => undefined });
    },
  });
});

afterEach(async () => {
  await harness.close();
});

const call = (method: 'get' | 'delete', path: string, data?: unknown) => axios.request({ method, url: harness.url(path), data, validateStatus: () => true });

describe('deleting a project', () => {
  it('previews what goes with it, and deletes it once its name is typed', async () => {
    expect((await call('get', '/api/projects/p1/removal')).data).toEqual({
      name: 'shop', repository: 'koala-t/shop', trees: [{ id: 't1', name: 'Shop features', leaves: 0, conversations: 0 }], keptConversations: 0, builds: 0, blockers: [], state: { state: 'none' },
    });
    expect((await call('delete', '/api/projects/p1', { confirm: 'Shop' })).status).toBe(400);

    const removed = await call('delete', '/api/projects/p1', { confirm: 'shop' });
    expect(removed.status).toBe(202);
    expect(started).toEqual(['remove-project-p1']);
    expect((await harness.db.getProjects()).find((project) => project.id === 'p1')?.removal).toEqual({ startedAt: 'now', requestedBy: TEST_USER.id });
  });

  it('is refused while an app built from it is deployed, and for someone else\'s project', async () => {
    await harness.db.saveDeployment({ id: 'd1', name: 'shop-web', clusterId: 'c', strategy: 'helm', gitappProjectId: 'p1' } as never);
    const refused = await call('delete', '/api/projects/p1', { confirm: 'shop' });
    expect(refused.status).toBe(409);
    expect(refused.data.blockers).toEqual(['the app "shop-web" built from it is still deployed; remove it first']);
    expect((await call('get', '/api/projects/p2/removal')).status).toBe(404);
    expect((await call('delete', '/api/projects/p2', { confirm: 'theirs' })).status).toBe(404);
  });
});
