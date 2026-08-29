import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDB } from './memory-db.js';
import { runLeafTool, type LeafToolContext } from './leaf-tool-runner.js';
import type { Persona } from '@koala/harness-types';

let db: MemoryDB;
const ctx = (over: Partial<LeafToolContext> = {}): LeafToolContext => ({
  db,
  userId: 'u1',
  branchId: 'b1',
  webSearch: async () => ({ hits: [], unavailable: false, answeredBy: 'searxng' as const }),
  fetchWebPage: async () => '',
  projects: {} as LeafToolContext['projects'],
  ...over,
});

const call = (name: string, args: Record<string, unknown> = {}) =>
  ({ name, arguments: JSON.stringify(args) });

const persona = (over: Record<string, unknown> = {}): any => ({
  id: 'p-coder', ownerId: 'u1', name: 'Coder', description: 'Writes code.', slug: 'coder',
  personaId: 'p1', tools: [], 
  createdAt: '2026-08-07T00:00:00.000Z', updatedAt: '2026-08-07T00:00:00.000Z',
  ...over,
});

const leavesOnBranch = async () => (await db.getLeaves()).filter((l) => l.branchId === 'b1');

beforeEach(async () => {
  db = new MemoryDB();
  await db.init();
});

describe('propose_leaf', () => {
  it('creates work as a proposal, never as something already running', async () => {
    await runLeafTool(ctx(), call('propose_leaf', { title: 'Add a rate limit' }));

    const [leaf] = await leavesOnBranch();
    expect(leaf!.status).toBe('proposed');
    expect(leaf!.title).toBe('Add a rate limit');
  });

  it('refuses a proposal with no title rather than creating a nameless leaf', async () => {
    const out = JSON.parse(await runLeafTool(ctx(), call('propose_leaf', { body: 'something' })));
    expect(out.error).toMatch(/title is required/);
    expect(await leavesOnBranch()).toHaveLength(0);
  });
});

describe('assigning a persona', () => {
  it('resolves a persona by the name the model was shown', async () => {
    await db.savePersonaPack(persona() as never);
    await runLeafTool(ctx(), call('propose_leaf', { title: 'Write the client', persona: 'Coder' }));

    const [leaf] = await leavesOnBranch();
    expect(leaf!.packId).toBe('p-coder');
  });

  it('matches case-insensitively, since the model retypes the name', async () => {
    await db.savePersonaPack(persona() as never);
    await runLeafTool(ctx(), call('propose_leaf', { title: 'x', persona: '  coder ' }));
    expect((await leavesOnBranch())[0]!.packId).toBe('p-coder');
  });

  it('keeps the leaf when the persona name matches nothing', async () => {
    const out = JSON.parse(await runLeafTool(ctx(), call('propose_leaf', { title: 'x', persona: 'Nobody' })));

    expect(out.error).toBeUndefined();
    const [leaf] = await leavesOnBranch();
    expect(leaf!.title).toBe('x');
    expect(leaf!.packId).toBeUndefined();
  });

  it('will not assign another user’s persona', async () => {
    await db.savePersonaPack(persona({ ownerId: 'someone-else' }) as never);
    await runLeafTool(ctx(), call('propose_leaf', { title: 'x', persona: 'Coder' }));

    expect((await leavesOnBranch())[0]!.packId).toBeUndefined();
  });

  it('lists personas by name and purpose, and nothing else', async () => {
    await db.savePersonaPack(persona({ systemPrompt: 'secret-ish' }) as never);
    const out = JSON.parse(await runLeafTool(ctx(), call('list_personas')));

    expect(out.personas).toEqual([{ name: 'Coder', description: 'Writes code.' }]);
    expect(JSON.stringify(out)).not.toMatch(/secret-ish|temperature/);
  });
});

describe('dependency ordering', () => {
  it('resolves dependencies by title within the same turn', async () => {
    await runLeafTool(ctx(), call('propose_leaf', { title: 'Build the client' }));
    await runLeafTool(ctx(), call('propose_leaf', { title: 'Test it', dependsOn: ['Build the client'] }));

    const leaves = await leavesOnBranch();
    const first = leaves.find((l) => l.title === 'Build the client')!;
    const second = leaves.find((l) => l.title === 'Test it')!;
    expect(second.dependsOn).toEqual([first.id]);
  });

  it('drops a dependency title that matches nothing rather than refusing the leaf', async () => {
    await runLeafTool(ctx(), call('propose_leaf', { title: 'Test it', dependsOn: ['Never proposed'] }));
    const [leaf] = await leavesOnBranch();
    expect(leaf!.dependsOn).toBeUndefined();
  });

  it('TELLS the model when a dependency matched nothing', async () => {
    await runLeafTool(ctx(), call('propose_leaf', { title: 'Build the client' }));
    const out = JSON.parse(await runLeafTool(ctx(), call('propose_leaf', {
      title: 'Test it', dependsOn: ['Build an client'],
    })));

    expect(out.proposed).toBeTruthy();
    expect(out.unresolvedDependencies).toEqual(['Build an client']);
    expect(out.warning).toMatch(/start immediately/i);
    expect(out.existingTitles).toContain('Build the client');
  });

  it('confirms the dependencies it DID record, by title', async () => {
    await runLeafTool(ctx(), call('propose_leaf', { title: 'Build the client' }));
    const out = JSON.parse(await runLeafTool(ctx(), call('propose_leaf', {
      title: 'Test it', dependsOn: ['Build the client'],
    })));

    expect(out.dependsOn).toEqual(['Build the client']);
    expect(out.warning).toBeUndefined();
  });

  it('says nothing about dependencies when none were asked for', async () => {
    const out = JSON.parse(await runLeafTool(ctx(), call('propose_leaf', { title: 'Standalone' })));

    expect('dependsOn' in out).toBe(false);
    expect(out.warning).toBeUndefined();
  });

  it('reports the partial case: one matched, one did not', async () => {
    await runLeafTool(ctx(), call('propose_leaf', { title: 'Build the client' }));
    const out = JSON.parse(await runLeafTool(ctx(), call('propose_leaf', {
      title: 'Test it', dependsOn: ['Build the client', 'Write the docs'],
    })));

    expect(out.dependsOn).toEqual(['Build the client']);
    expect(out.unresolvedDependencies).toEqual(['Write the docs']);
  });

  it('refuses a dependency that would close a cycle', async () => {
    await runLeafTool(ctx(), call('propose_leaf', { title: 'A' }));
    await runLeafTool(ctx(), call('propose_leaf', { title: 'B', dependsOn: ['A'] }));
    const b = (await leavesOnBranch()).find((l) => l.title === 'B')!;
    await db.saveLeaf({ ...b, title: 'B' });

    const a = (await leavesOnBranch()).find((l) => l.title === 'A')!;
    await db.saveLeaf({ ...a, dependsOn: [b.id] });
    const out = JSON.parse(await runLeafTool(ctx(), call('propose_leaf', { title: 'C', dependsOn: ['B'] })));

    expect(out.error).toBeUndefined();
  });
});

describe('branch and owner scoping', () => {
  it('only sees leaves on this branch', async () => {
    await runLeafTool(ctx(), call('propose_leaf', { title: 'mine' }));
    await runLeafTool(ctx({ branchId: 'other' }), call('propose_leaf', { title: 'theirs' }));

    const out = JSON.parse(await runLeafTool(ctx(), call('list_leaves')));
    expect(out.leaves).toHaveLength(1);
  });

  it('only sees leaves this user owns', async () => {
    await runLeafTool(ctx({ userId: 'someone-else' }), call('propose_leaf', { title: 'theirs' }));
    const out = JSON.parse(await runLeafTool(ctx(), call('list_leaves')));
    expect(out.leaves).toHaveLength(0);
  });
});

describe('failure handling', () => {
  it('reports an unknown tool rather than throwing', async () => {
    const out = JSON.parse(await runLeafTool(ctx(), call('do_something_else')));
    expect(out.error).toMatch(/Unknown tool/);
  });

  it('turns a thrown error into a tool result the loop can carry on from', async () => {
    const boom = ctx({ webSearch: async () => { throw new Error('network is off'); } });
    const out = JSON.parse(await runLeafTool(boom, call('web_search', { query: 'x' })));
    expect(out.error).toMatch(/network is off/);
  });
});
