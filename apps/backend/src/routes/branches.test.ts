import { describe, it, expect, afterAll } from 'vitest';
import { branchesRouter } from './branches.js';
import { mountRouter, type Harness, TEST_USER } from './test-harness.js';
import type { Database } from '../lib/db-interface.js';

const harness: Harness = await mountRouter({
  prefix: '/api/branches',
  router: (db: Database) => branchesRouter({ db, temporalBridge: {} as any }),
});

afterAll(async () => { await harness.close(); });

describe('POST /api/branches — tree-less, project-scoped branches', () => {
  it('creates a branch with no treeId and no projectId at all', async () => {
    const res = await fetch(harness.url('/api/branches'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; treeId?: string; projectId?: string };
    expect(body.treeId).toBeUndefined();
    expect(body.projectId).toBeUndefined();
  });

  it('creates a branch scoped to a project when projectId is given', async () => {
    await harness.db.saveProjectInfo({
      id: 'proj-1', name: 'demo', ownerId: TEST_USER.id, appType: 'local', createdAt: '2026-01-01T00:00:00Z',
    } as never);

    const res = await fetch(harness.url('/api/branches'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'proj-1' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; projectId?: string };
    expect(body.projectId).toBe('proj-1');

    const saved = (await harness.db.getBranches()).find((b) => b.id === body.id);
    expect(saved?.projectId).toBe('proj-1');
  });

  it('404s when the project does not exist or belongs to someone else', async () => {
    await harness.db.saveProjectInfo({
      id: 'proj-not-mine', name: 'demo', ownerId: 'someone-else', appType: 'local', createdAt: '2026-01-01T00:00:00Z',
    } as never);

    const missing = await fetch(harness.url('/api/branches'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'no-such-project' }),
    });
    expect(missing.status).toBe(404);

    const notMine = await fetch(harness.url('/api/branches'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'proj-not-mine' }),
    });
    expect(notMine.status).toBe(404);
  });
});
