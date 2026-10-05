import { GroveRunService } from '../services/GroveRunService.js';
import { describe, it, expect, afterEach, vi } from 'vitest';
import axios from 'axios';
import { treeTypesRouter } from './tree-types.js';
import { treesRouter } from './trees.js';
import { branchesRouter } from './branches.js';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import { seedTreeTypes } from '../lib/tree-types.js';
import { seedWorkspaceImages } from '../lib/workspace-image-seeds.js';
import { GroveDeletionService } from '../services/GroveDeletionService.js';
import type { Database } from '../lib/db-interface.js';
const deletionFor = (db: Database, terminated: string[] = [], released: string[] = []) => new GroveDeletionService({
  store: db,
  workflows: { terminate: async (workflowId: string) => { terminated.push(workflowId); return false; } },
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
    await seedTreeTypes(h.db);
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
    await seedTreeTypes(h.db);
    await seedWorkspaceImages(h.db);
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
    await seedTreeTypes(h.db);
    await seedWorkspaceImages(h.db);
    const paper = ((await axios.get(h.url('/api/tree-types'))).data as { id: string }[]).find((t) => t.id === 'research-paper')!;

    const saved = await axios.put(h.url('/api/tree-types/research-paper'), { ...paper, agent: 'research' });
    expect(saved.data.agent).toBe('research');

    const unknown = await axios.put(h.url('/api/tree-types/research-paper'), { ...paper, agent: 'nobody' }, { validateStatus: () => true });
    expect(unknown.status).toBe(400);
    expect(unknown.data.error).toContain('"nobody"');
  });
});

describe('trees', () => {
  const mount = async () => {
    h = await mountRouter({
      prefix: '/api/trees',
      router: (db) => treesRouter({ db, workspaces: { state: async () => 'none', release: async () => ({ saved: false as const, why: 'no documents in this test' }) }, runs: new GroveRunService({ store: db, launcher: { startGroveRun: async () => ({ started: false, reason: 'unavailable' }), groveRunStatus: async () => ({ state: 'none' }), signalGroveRun: async () => false } }), deletion: deletionFor(db) }),
    });
    await seedTreeTypes(h.db);
    return h!;
  };

  it('lists only the caller\'s own', async () => {
    const harness = await mount();
    await harness.db.saveTree({ id: 't1', ownerId: TEST_USER.id, name: 'mine', projectIds: [] } as never);
    await harness.db.saveTree({ id: 't2', ownerId: 'someone-else', name: 'theirs', projectIds: [] } as never);
    const res = await axios.get(harness.url('/api/trees'));
    expect(res.data.map((t: { name: string }) => t.name)).toEqual(['mine']);
  });

  it('does not let one tenant read another\'s by guessing the id', async () => {
    const harness = await mount();
    await harness.db.saveTree({ id: 't2', ownerId: 'someone-else', name: 'theirs', projectIds: [] } as never);
    const err = await axios.get(harness.url('/api/trees/t2/run')).catch((e) => e);
    expect(err.response.status).toBe(404);
  });

  it('creates a tree owned by the session user, not by anything in the body', async () => {
    const harness = await mount();
    const res = await axios.post(harness.url('/api/trees'), {
      name: 'new', goal: 'g', type: 'research-paper', ownerId: 'someone-else',
    }, { validateStatus: () => true });
    expect(res.status, JSON.stringify(res.data)).toBeLessThan(300);
    const stored = (await harness.db.getTrees()).find((t) => t.name === 'new');
    expect(stored?.ownerId).toBe(TEST_USER.id);
  });
});

describe('branches', () => {
  const mount = async () => {
    h = await mountRouter({
      prefix: '/api/branches',
      router: (db) => branchesRouter({ db, deletion: deletionFor(db) }),
    });
    return h!;
  };

  it('lists only the caller\'s own', async () => {
    const harness = await mount();
    await harness.db.saveBranch({ id: 'b1', ownerId: TEST_USER.id, title: 'mine', treeId: 't1' } as never);
    await harness.db.saveBranch({ id: 'b2', ownerId: 'someone-else', title: 'theirs', treeId: 't1' } as never);
    const res = await axios.get(harness.url('/api/branches'));
    expect(res.data.map((b: { title: string }) => b.title)).toEqual(['mine']);
  });

  it('404s a branch belonging to someone else rather than 403', async () => {
    const harness = await mount();
    await harness.db.saveBranch({ id: 'b2', ownerId: 'someone-else', title: 'theirs', treeId: 't1' } as never);
    const err = await axios.delete(harness.url('/api/branches/b2')).catch((e) => e);
    expect(err.response.status).toBe(404);
    const stored = (await harness.db.getBranches()).find((b) => b.id === 'b2');
    expect(stored?.title).toBe('theirs');
  });
});
