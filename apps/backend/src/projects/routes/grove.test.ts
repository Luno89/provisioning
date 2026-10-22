import { GroveRunService } from '../services/GroveRunService.js';
import { GroveOrderService } from '../services/GroveOrderService.js';
import { describe, it, expect, afterEach, vi } from 'vitest';
import axios from 'axios';
import { treeTypesRouter } from './tree-types.js';
import { treesRouter } from './trees.js';
import { branchesRouter } from './branches.js';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { seedTreeTypes } from '../lib/tree-types.js';
import { seedWorkspaceImages } from '../../engine/lib/workspace-image-seeds.js';
import { GroveDeletionService } from '../services/GroveDeletionService.js';
import type { Database } from '../../platform/lib/db-interface.js';
const deletionFor = (db: Database, terminated: string[] = [], released: string[] = []) => new GroveDeletionService({
  store: db,
  workflows: { stop: async (workflowId: string) => { terminated.push(workflowId); return false; } },
  workspaces: { release: async (treeId: string) => { released.push(treeId); } },
});


const AGENTS = ['planner', 'leaf-worker', 'grove-runner', 'research'];

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; vi.restoreAllMocks(); });


describe('the tree-type catalogue', () => {
  it('serves the seeded catalogue to every user', async () => {
    h = await mountRouter({
      prefix: '/api/tree-types',
      router: (db) => treeTypesRouter({ db, agents: async () => AGENTS }),
    });
    // Setup seeds; the route no longer does it lazily on read.
    await seedTreeTypes(h.db.projects);
    const res = await axios.get(h.url('/api/tree-types'));
    expect(res.status).toBe(200);
    expect(res.data.length).toBeGreaterThan(0);
    const again = await axios.get(h.url('/api/tree-types'));
    expect(again.data.length).toBe(res.data.length);
  });

  it('refuses an unauthenticated caller', async () => {
    h = await mountRouter({
      prefix: '/api/tree-types',
      user: null,
      router: (db) => treeTypesRouter({ db, agents: async () => AGENTS }),
    });
    await expect(axios.get(h.url('/api/tree-types'))).rejects.toMatchObject({
      response: { status: 401 },
    });
  });

  it('does not list a built-in type twice after the user edits it', async () => {
    h = await mountRouter({
      prefix: '/api/tree-types',
      router: (db) => treeTypesRouter({ db, agents: async () => AGENTS }),
    });
    await seedTreeTypes(h.db.projects);
    await seedWorkspaceImages(h.db.engine);
    const before = (await axios.get(h.url('/api/tree-types'))).data as { id: string; ownerId?: string }[];
    const target = before.find((t) => t.id === 'mcp-server')!;
    const occurrencesBefore = before.filter((t) => t.id === 'mcp-server').length;
    expect(occurrencesBefore).toBe(1);

    await axios.put(h.url(`/api/tree-types/${target.id}`), { ...target, summary: 'Edited summary' });

    const after = (await axios.get(h.url('/api/tree-types'))).data as { id: string; ownerId?: string; summary: string }[];
    const matches = after.filter((t) => t.id === 'mcp-server');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.summary).toBe('Edited summary');
    expect(matches[0]?.ownerId).toBe(TEST_USER.id);
  });

  it('keeps the agent a type names to grow its trees, and refuses one that is not an agent', async () => {
    h = await mountRouter({
      prefix: '/api/tree-types',
      router: (db) => treeTypesRouter({ db, agents: async () => AGENTS }),
    });
    await seedTreeTypes(h.db.projects);
    await seedWorkspaceImages(h.db.engine);
    const paper = ((await axios.get(h.url('/api/tree-types'))).data as { id: string }[]).find((t) => t.id === 'research-paper')!;

    const saved = await axios.put(h.url('/api/tree-types/research-paper'), { ...paper, agent: 'research' });
    expect(saved.data.agent).toBe('research');

    const unknown = await axios.put(h.url('/api/tree-types/research-paper'), { ...paper, agent: 'nobody' }, { validateStatus: () => true });
    expect(unknown.status).toBe(400);
    expect(unknown.data.error).toContain('"nobody"');
  });

  it('deletes a person\'s copy of a shipped type even while trees use it, since they fall back to the shipped one', async () => {
    h = await mountRouter({
      prefix: '/api/tree-types',
      router: (db) => treeTypesRouter({ db, agents: async () => AGENTS }),
    });
    await seedTreeTypes(h.db.projects);
    await seedWorkspaceImages(h.db.engine);
    const shipped = ((await axios.get(h.url('/api/tree-types'))).data as { id: string; summary: string }[]).find((t) => t.id === 'api-service')!;
    await axios.put(h.url('/api/tree-types/api-service'), { ...shipped, summary: 'Mine' });
    await h.db.projects.saveTree({ id: 't1', ownerId: TEST_USER.id, name: 'shortener', type: 'api-service', createdAt: 'x', updatedAt: 'x' } as never);

    expect((await axios.delete(h.url('/api/tree-types/api-service'))).status).toBe(200);
    const listed = ((await axios.get(h.url('/api/tree-types'))).data as { id: string; summary: string; ownerId?: string }[]).filter((t) => t.id === 'api-service');
    expect(listed).toEqual([expect.objectContaining({ summary: shipped.summary })]);
    expect(listed[0]).not.toHaveProperty('ownerId');
  });

  it('refuses to delete a type of a person\'s own that trees still use', async () => {
    h = await mountRouter({
      prefix: '/api/tree-types',
      router: (db) => treeTypesRouter({ db, agents: async () => AGENTS }),
    });
    await seedTreeTypes(h.db.projects);
    await seedWorkspaceImages(h.db.engine);
    const shipped = ((await axios.get(h.url('/api/tree-types'))).data as { id: string }[]).find((t) => t.id === 'api-service')!;
    await axios.put(h.url('/api/tree-types/my-own-kind'), { ...shipped, id: 'my-own-kind', label: 'Mine' });
    await h.db.projects.saveTree({ id: 't1', ownerId: TEST_USER.id, name: 'thing', type: 'my-own-kind', createdAt: 'x', updatedAt: 'x' } as never);

    const refused = await axios.delete(h.url('/api/tree-types/my-own-kind'), { validateStatus: () => true });
    expect(refused.status).toBe(409);
    expect(refused.data.error).toBe('1 tree(s) still use this type: thing.');
  });
});

describe('trees', () => {
  const mount = async () => {
    h = await mountRouter({
      prefix: '/api/trees',
      router: (db) => treesRouter({ db, workspaces: { state: async () => 'none', release: async () => ({ saved: false as const, why: 'no documents in this test' }) }, runs: new GroveRunService({ store: db, launcher: { startGroveRun: async () => ({ started: false, reason: 'unavailable' }), groveRunStatus: async () => ({ state: 'none' }), signalGroveRun: async () => false } }), deletion: deletionFor(db), order: new GroveOrderService({ store: db.projects, now: () => 'now' }), home: { home: async (tree) => tree }, models: { view: async () => ({ ok: true as const, value: { rows: [] } }), set: async () => ({ ok: true as const, value: { rows: [] } }) } }),
    });
    await seedTreeTypes(h.db.projects);
    return h!;
  };

  it('lists only the caller\'s own', async () => {
    const harness = await mount();
    await harness.db.projects.saveTree({ id: 't1', ownerId: TEST_USER.id, name: 'mine', projectIds: [] } as never);
    await harness.db.projects.saveTree({ id: 't2', ownerId: 'someone-else', name: 'theirs', projectIds: [] } as never);
    const res = await axios.get(harness.url('/api/trees'));
    expect(res.data.map((t: { name: string }) => t.name)).toEqual(['mine']);
  });

  it('does not let one tenant read another\'s by guessing the id', async () => {
    const harness = await mount();
    await harness.db.projects.saveTree({ id: 't2', ownerId: 'someone-else', name: 'theirs', projectIds: [] } as never);
    const err = await axios.get(harness.url('/api/trees/t2/run')).catch((e) => e);
    expect(err.response.status).toBe(404);
  });

  it('saves the order of a tree\'s features, and refuses one naming a feature of another tree or another person\'s tree', async () => {
    const harness = await mount();
    await harness.db.projects.saveTree({ id: 't1', ownerId: TEST_USER.id, name: 'mine', projectIds: [] } as never);
    await harness.db.projects.saveTree({ id: 't2', ownerId: 'someone-else', name: 'theirs', projectIds: [] } as never);
    for (const [id, treeId] of [['b1', 't1'], ['b2', 't1'], ['bx', 't9']] as const) await harness.db.projects.saveBranch({ id, ownerId: TEST_USER.id, title: id, treeId, createdAt: 'then', updatedAt: 'then' });
    const ok = await axios.put(harness.url('/api/trees/t1/order'), { branchIds: ['b2', 'b1'] });
    expect(ok.data).toEqual({ ordered: 2 });
    expect((await harness.db.projects.getBranches()).filter((branch) => branch.treeId === 't1').map((branch) => [branch.id, branch.priority])).toEqual([['b1', 1], ['b2', 0]]);
    const outside = await axios.put(harness.url('/api/trees/t1/order'), { branchIds: ['bx'] }, { validateStatus: () => true });
    expect([outside.status, outside.data.error]).toEqual([400, 'bx is not among the features here']);
    expect((await axios.put(harness.url('/api/trees/t2/order'), { branchIds: [] }, { validateStatus: () => true })).status).toBe(404);
  });

  it('creates a tree owned by the session user, not by anything in the body', async () => {
    const harness = await mount();
    const res = await axios.post(harness.url('/api/trees'), {
      name: 'new', goal: 'g', type: 'research-paper', ownerId: 'someone-else',
    }, { validateStatus: () => true });
    expect(res.status, JSON.stringify(res.data)).toBeLessThan(300);
    const stored = (await harness.db.projects.getTrees()).find((t) => t.name === 'new');
    expect(stored?.ownerId).toBe(TEST_USER.id);
  });
});

describe('branches', () => {
  const mount = async () => {
    h = await mountRouter({
      prefix: '/api/branches',
      router: (db) => branchesRouter({ db: db.projects, deletion: deletionFor(db), order: new GroveOrderService({ store: db.projects, now: () => 'now' }) }),
    });
    return h!;
  };

  it('saves the order of a feature\'s stories, and refuses another person\'s feature', async () => {
    const harness = await mount();
    await harness.db.projects.saveBranch({ id: 'b1', ownerId: TEST_USER.id, title: 'mine', treeId: 't1', createdAt: 'then', updatedAt: 'then' });
    await harness.db.projects.saveBranch({ id: 'b2', ownerId: 'someone-else', title: 'theirs', treeId: 't2', createdAt: 'then', updatedAt: 'then' });
    for (const id of ['l1', 'l2', 'l3']) await harness.db.projects.saveLeaf({ id, ownerId: TEST_USER.id, branchId: 'b1', title: id, status: 'pending', createdAt: 'then', updatedAt: 'then' });
    expect((await axios.put(harness.url('/api/branches/b1/order'), { leafIds: ['l3', 'l1', 'l2'] })).data).toEqual({ ordered: 3 });
    expect((await harness.db.projects.getLeaves()).map((leaf) => [leaf.id, leaf.priority])).toEqual([['l1', 1], ['l2', 2], ['l3', 0]]);
    const twice = await axios.put(harness.url('/api/branches/b1/order'), { leafIds: ['l1', 'l1'] }, { validateStatus: () => true });
    expect([twice.status, twice.data.error]).toEqual([400, 'a story appears twice in the order']);
    expect((await axios.put(harness.url('/api/branches/b2/order'), { leafIds: [] }, { validateStatus: () => true })).status).toBe(404);
  });

  it('lists only the caller\'s own', async () => {
    const harness = await mount();
    await harness.db.projects.saveBranch({ id: 'b1', ownerId: TEST_USER.id, title: 'mine', treeId: 't1' } as never);
    await harness.db.projects.saveBranch({ id: 'b2', ownerId: 'someone-else', title: 'theirs', treeId: 't1' } as never);
    const res = await axios.get(harness.url('/api/branches'));
    expect(res.data.map((b: { title: string }) => b.title)).toEqual(['mine']);
  });

  it('404s a branch belonging to someone else rather than 403', async () => {
    const harness = await mount();
    await harness.db.projects.saveBranch({ id: 'b2', ownerId: 'someone-else', title: 'theirs', treeId: 't1' } as never);
    const err = await axios.delete(harness.url('/api/branches/b2')).catch((e) => e);
    expect(err.response.status).toBe(404);
    const stored = (await harness.db.projects.getBranches()).find((b) => b.id === 'b2');
    expect(stored?.title).toBe('theirs');
  });
});

describe('a tree type\'s description', () => {
  it('is served for a person\'s type, and not for one they do not have', async () => {
    h = await mountRouter({
      prefix: '/api/tree-types',
      router: (db) => treeTypesRouter({ db, agents: async () => AGENTS, describe: async (_ownerId, typeId) => (typeId === 'odoo-addons' ? 'Odoo addons (odoo-addons): …' : undefined) }),
    });
    expect((await axios.get(h.url('/api/tree-types/odoo-addons/description'))).data).toEqual({ text: 'Odoo addons (odoo-addons): …' });
    expect((await axios.get(h.url('/api/tree-types/nope/description'), { validateStatus: () => true })).status).toBe(404);
  });
});

