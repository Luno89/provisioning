import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDB } from './memory-db.js';
import { runLeafTool, type LeafToolContext } from './tool-registry.js';
import type { Persona } from '@koala/harness-types';
import { seedTools } from './tool-seeds.js';

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
  await seedTools(db);
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

  /**
   * revise_leaf used to resolve the name against db.getPersonas() (a different collection with
   * different ids) and then write that id into packId anyway — a name that matched still wrote the
   * wrong kind of id, silently breaking the assignment the model thought it had just fixed.
   */
  it('revise_leaf assigns the same kind of id propose_leaf does, not a persona id', async () => {
    await db.savePersonaPack(persona() as never);
    await runLeafTool(ctx(), call('propose_leaf', { title: 'x' }));
    const [leaf] = await leavesOnBranch();

    const out = JSON.parse(await runLeafTool(ctx(), call('revise_leaf', { id: leaf!.id, persona: 'Coder' })));

    expect(out.error).toBeUndefined();
    expect(out.revised.persona).toBe('Coder');
    expect((await leavesOnBranch())[0]!.packId).toBe('p-coder');
  });
});

describe('assigning a project', () => {
  const oneProject = {
    listForOwner: async () => [{
      id: 'proj-1', name: 'Gitea MCP Server', giteaOwner: 'me', giteaRepo: 'gitea-mcp',
      appType: 'mcp-server', createdAt: '2026-08-07T00:00:00.000Z',
    }],
  } as unknown as LeafToolContext['projects'];

  /**
   * A bad projectId used to be dropped with only a server-side console.warn — the model had no
   * way to know it had guessed wrong, and would repeat the same mistake on every later leaf.
   */
  it('tells the model when a projectId matches nothing, rather than silently dropping it', async () => {
    const out = JSON.parse(await runLeafTool(
      ctx({ projects: oneProject }),
      call('propose_leaf', { title: 'x', projectId: 'no-such-project' }),
    ));

    expect(out.error).toBeUndefined();
    expect(out.projectWarning).toMatch(/no-such-project/);
    expect(out.availableProjects).toEqual([{ id: 'proj-1', name: 'Gitea MCP Server' }]);
    expect((await leavesOnBranch())[0]!.projectId).toBeUndefined();
  });

  it('assigns a project that does match, and says so plainly', async () => {
    const out = JSON.parse(await runLeafTool(
      ctx({ projects: oneProject }),
      call('propose_leaf', { title: 'x', projectId: 'proj-1' }),
    ));

    expect(out.projectWarning).toBeUndefined();
    expect(out.project).toBe('Gitea MCP Server');
    expect((await leavesOnBranch())[0]!.projectId).toBe('proj-1');
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

describe('revise_leaf on pending and dependsOn', () => {
  it('revises a pending leaf, not just a proposed one', async () => {
    await runLeafTool(ctx(), call('propose_leaf', { title: 'x' }));
    const [leaf] = await leavesOnBranch();
    await db.saveLeaf({ ...leaf!, status: 'pending' });

    const out = JSON.parse(await runLeafTool(ctx(), call('revise_leaf', { id: leaf!.id, title: 'renamed' })));
    expect(out.error).toBeUndefined();
    expect((await leavesOnBranch())[0]!.title).toBe('renamed');
  });

  it('refuses to revise a leaf that is already running', async () => {
    await runLeafTool(ctx(), call('propose_leaf', { title: 'x' }));
    const [leaf] = await leavesOnBranch();
    await db.saveLeaf({ ...leaf!, status: 'running' });

    const out = JSON.parse(await runLeafTool(ctx(), call('revise_leaf', { id: leaf!.id, title: 'renamed' })));
    expect(out.error).toMatch(/already running/);
  });

  it('replaces dependsOn wholesale, by title', async () => {
    await runLeafTool(ctx(), call('propose_leaf', { title: 'A' }));
    await runLeafTool(ctx(), call('propose_leaf', { title: 'B' }));
    await runLeafTool(ctx(), call('propose_leaf', { title: 'C', dependsOn: ['A'] }));
    const a = (await leavesOnBranch()).find((l) => l.title === 'A')!;
    const b = (await leavesOnBranch()).find((l) => l.title === 'B')!;
    const c = (await leavesOnBranch()).find((l) => l.title === 'C')!;

    const out = JSON.parse(await runLeafTool(ctx(), call('revise_leaf', { id: c.id, dependsOn: ['B'] })));
    expect(out.error).toBeUndefined();
    expect(out.dependsOn).toEqual(['B']);
    expect((await leavesOnBranch()).find((l) => l.id === c.id)!.dependsOn).toEqual([b.id]);
    expect((await leavesOnBranch()).find((l) => l.id === c.id)!.dependsOn).not.toContain(a.id);
  });

  it('clears dependsOn entirely when given an empty array', async () => {
    await runLeafTool(ctx(), call('propose_leaf', { title: 'A' }));
    await runLeafTool(ctx(), call('propose_leaf', { title: 'B', dependsOn: ['A'] }));
    const b = (await leavesOnBranch()).find((l) => l.title === 'B')!;

    await runLeafTool(ctx(), call('revise_leaf', { id: b.id, dependsOn: [] }));
    const revised = (await leavesOnBranch()).find((l) => l.id === b.id)!;
    expect('dependsOn' in revised).toBe(false);
  });

  it('refuses a dependsOn change that would close a cycle', async () => {
    await runLeafTool(ctx(), call('propose_leaf', { title: 'A' }));
    await runLeafTool(ctx(), call('propose_leaf', { title: 'B', dependsOn: ['A'] }));
    const a = (await leavesOnBranch()).find((l) => l.title === 'A')!;
    const b = (await leavesOnBranch()).find((l) => l.title === 'B')!;

    const out = JSON.parse(await runLeafTool(ctx(), call('revise_leaf', { id: a.id, dependsOn: ['B'] })));
    expect(out.error).toMatch(/cycle/);
    expect((await leavesOnBranch()).find((l) => l.id === a.id)!.dependsOn).toBeUndefined();
    void b;
  });

  it('leaves dependsOn untouched when the field is omitted', async () => {
    await runLeafTool(ctx(), call('propose_leaf', { title: 'A' }));
    await runLeafTool(ctx(), call('propose_leaf', { title: 'B', dependsOn: ['A'] }));
    const b = (await leavesOnBranch()).find((l) => l.title === 'B')!;

    await runLeafTool(ctx(), call('revise_leaf', { id: b.id, title: 'B renamed' }));
    const revised = (await leavesOnBranch()).find((l) => l.id === b.id)!;
    expect(revised.title).toBe('B renamed');
    expect(revised.dependsOn).toBeDefined();
  });
});

describe('delete_leaf', () => {
  const signals: { id: string; signal: string }[] = [];
  const bridge = () => ({
    signalLeaf: async (id: string, signal: string) => { signals.push({ id, signal }); return true; },
  });

  beforeEach(() => { signals.length = 0; });

  it('deletes a proposed leaf without needing the workflow engine', async () => {
    await runLeafTool(ctx(), call('propose_leaf', { title: 'x' }));
    const [leaf] = await leavesOnBranch();

    const out = JSON.parse(await runLeafTool(ctx(), call('delete_leaf', { id: leaf!.id })));
    expect(out.error).toBeUndefined();
    expect(out.deleted.title).toBe('x');
    expect(await leavesOnBranch()).toHaveLength(0);
  });

  it('cancels a running leaf in the workflow engine before deleting it', async () => {
    await runLeafTool(ctx(), call('propose_leaf', { title: 'x' }));
    const [leaf] = await leavesOnBranch();
    await db.saveLeaf({ ...leaf!, status: 'running' });

    const out = JSON.parse(await runLeafTool(
      ctx({ temporalBridge: bridge() as never }),
      call('delete_leaf', { id: leaf!.id }),
    ));
    expect(out.error).toBeUndefined();
    expect(signals).toEqual([{ id: leaf!.id, signal: 'cancelLeaf' }]);
    expect(await leavesOnBranch()).toHaveLength(0);
  });

  it('refuses to delete a leaf that already succeeded', async () => {
    await runLeafTool(ctx(), call('propose_leaf', { title: 'x' }));
    const [leaf] = await leavesOnBranch();
    await db.saveLeaf({ ...leaf!, status: 'succeeded' });

    const out = JSON.parse(await runLeafTool(ctx(), call('delete_leaf', { id: leaf!.id })));
    expect(out.error).toMatch(/succeeded/);
    expect(await leavesOnBranch()).toHaveLength(1);
  });

  it('cascades to sub-leaves, and refuses the whole thing if any sub-leaf succeeded', async () => {
    await runLeafTool(ctx(), call('propose_leaf', { title: 'parent' }));
    const [parent] = await leavesOnBranch();
    await runLeafTool(ctx(), call('propose_leaf', { title: 'child', parentLeafId: parent!.id }));
    const child = (await leavesOnBranch()).find((l) => l.title === 'child')!;
    await db.saveLeaf({ ...child, status: 'succeeded' });

    const out = JSON.parse(await runLeafTool(ctx(), call('delete_leaf', { id: parent!.id })));
    expect(out.error).toMatch(/succeeded/);
    expect(await leavesOnBranch()).toHaveLength(2);
  });

  it('deletes sub-leaves along with the parent when none of them succeeded', async () => {
    await runLeafTool(ctx(), call('propose_leaf', { title: 'parent' }));
    const [parent] = await leavesOnBranch();
    await runLeafTool(ctx(), call('propose_leaf', { title: 'child', parentLeafId: parent!.id }));

    const out = JSON.parse(await runLeafTool(ctx(), call('delete_leaf', { id: parent!.id })));
    expect(out.deleted.alsoRemoved).toBe(1);
    expect(await leavesOnBranch()).toHaveLength(0);
  });

  it('warns about leaves that depended on the deleted one', async () => {
    await runLeafTool(ctx(), call('propose_leaf', { title: 'A' }));
    await runLeafTool(ctx(), call('propose_leaf', { title: 'B', dependsOn: ['A'] }));
    const a = (await leavesOnBranch()).find((l) => l.title === 'A')!;

    const out = JSON.parse(await runLeafTool(ctx(), call('delete_leaf', { id: a.id })));
    expect(out.warning).toMatch(/"B"/);
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

/**
 * The bug this whole change came from: a chat has no branch, so every leaf tool was unreachable
 * from one -- and rather than saying so, dispatch answered `No tool named "get_leaf"`.
 */
describe('reading leaves from somewhere with no branch', () => {
  const noBranch = () => ctx({ branchId: undefined });

  const twoBranches = async () => {
    await runLeafTool(ctx(), call('propose_leaf', { title: 'on b1' }));
    await runLeafTool(ctx({ branchId: 'b2' }), call('propose_leaf', { title: 'on b2' }));
  };

  it('lists every leaf the owner has, not the ones on one branch', async () => {
    await twoBranches();
    const out = JSON.parse(await runLeafTool(noBranch(), call('list_leaves')));
    expect(out.leaves.map((l: { title: string }) => l.title).sort()).toEqual(['on b1', 'on b2']);
  });

  it('says which branch and tree each leaf is on, so a list spanning both still reads', async () => {
    await db.saveBranch({
      id: 'b1', ownerId: 'u1', treeId: 't1', title: 'Request', messages: [],
      createdAt: 'now', updatedAt: 'now',
    } as never);
    await db.saveTree({ id: 't1', ownerId: 'u1', name: 'The Client' } as never);
    await runLeafTool(ctx(), call('propose_leaf', { title: 'on b1' }));

    const [leaf] = JSON.parse(await runLeafTool(noBranch(), call('list_leaves'))).leaves;
    expect(leaf.branchId).toBe('b1');
    expect(leaf.tree).toBe('The Client');
  });

  it('narrows to one tree when asked, and refuses a tree that is not yours', async () => {
    await db.saveBranch({
      id: 'b1', ownerId: 'u1', treeId: 't1', title: 'Request', messages: [],
      createdAt: 'now', updatedAt: 'now',
    } as never);
    await twoBranches();

    const mine = JSON.parse(await runLeafTool(noBranch(), call('list_leaves', { treeId: 't1' })));
    expect(mine.leaves.map((l: { title: string }) => l.title)).toEqual(['on b1']);

    const nope = JSON.parse(await runLeafTool(noBranch(), call('list_leaves', { treeId: 'nope' })));
    expect(nope.error).toMatch(/no treeId "nope"/);
  });

  it('finds a leaf by id wherever it lives, because an id is an id', async () => {
    await runLeafTool(ctx({ branchId: 'b2' }), call('propose_leaf', { title: 'elsewhere' }));
    const [leaf] = await db.getLeaves();

    const out = JSON.parse(await runLeafTool(noBranch(), call('get_leaf', { id: leaf!.id })));
    expect(out.title).toBe('elsewhere');
  });

  it('tells a write which argument would give it a branch, rather than refusing the tool', async () => {
    const out = JSON.parse(await runLeafTool(noBranch(), call('propose_leaf', { title: 'x' })));
    expect(out.error).toMatch(/works on one branch/);
    expect(out.error).toMatch(/treeId/);
  });

  it('lets a write name its branch, so proposing from a chat works', async () => {
    await db.saveBranch({
      id: 'b1', ownerId: 'u1', treeId: 't1', title: 'Request', messages: [],
      createdAt: 'now', updatedAt: 'now',
    } as never);

    const out = JSON.parse(await runLeafTool(noBranch(), call('propose_leaf', { title: 'from chat', treeId: 't1' })));
    expect(out.error).toBeUndefined();
    expect((await db.getLeaves())[0]!.branchId).toBe('b1');
  });

  it('changes a leaf found by id without being told which branch it is on', async () => {
    await runLeafTool(ctx({ branchId: 'b2' }), call('propose_leaf', { title: 'elsewhere' }));
    const [leaf] = await db.getLeaves();

    const out = JSON.parse(await runLeafTool(noBranch(), call('revise_leaf', { id: leaf!.id, title: 'renamed' })));
    expect(out.revised.title).toBe('renamed');
  });
});

describe('failure handling', () => {
  it('reports an unknown tool rather than throwing', async () => {
    const out = JSON.parse(await runLeafTool(ctx(), call('do_something_else')));
    expect(out.error).toMatch(/no tool called/);
  });

  /**
   * A granted tool that this run cannot serve must say what is missing. Answering "no such tool"
   * was a lie -- the tool existed, was granted, and was offered -- and it sent the model looking
   * for a different tool instead of for the argument or the runtime it needed.
   */
  it('names the resource a granted tool is missing, rather than denying the tool exists', async () => {
    const out = JSON.parse(await runLeafTool(ctx({ projects: undefined }), call('list_projects')));
    expect(out.error).toMatch(/list_projects needs/);
    expect(out.error).not.toMatch(/no tool called/);
  });

  it('turns a thrown error into a tool result the loop can carry on from', async () => {
    const boom = ctx({ webSearch: async () => { throw new Error('network is off'); } });
    const out = JSON.parse(await runLeafTool(boom, call('web_search', { query: 'x' })));
    expect(out.error).toMatch(/network is off/);
  });
});
