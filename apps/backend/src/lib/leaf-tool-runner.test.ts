/**
 * Tool execution, testable for the first time.
 *
 * This lived inside a closure in the Express bootstrap, so the only way to reach it was an HTTP
 * request against a running server — which is why the code that actually creates leaves had schema
 * tests and no behaviour tests. Passing its dependencies in was the point of the extraction; these
 * are the cases that were previously unreachable.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDB } from './memory-db.js';
import { runLeafTool, type LeafToolContext } from './leaf-tool-runner.js';
import type { Persona } from '@koala/harness-types';

let db: MemoryDB;
const ctx = (over: Partial<LeafToolContext> = {}): LeafToolContext => ({
  db,
  userId: 'u1',
  branchId: 'b1',
  webSearch: async () => [],
  fetchWebPage: async () => '',
  projects: {} as LeafToolContext['projects'],
  ...over,
});

const call = (name: string, args: Record<string, unknown> = {}) =>
  ({ name, arguments: JSON.stringify(args) });

const persona = (over: Partial<Persona> = {}): Persona => ({
  id: 'p-coder', ownerId: 'u1', name: 'Coder', description: 'Writes code.', overrides: {},
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
    // A tool call is the model suggesting, not deciding — nothing spends until a human accepts.
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
    await db.savePersona(persona());
    await runLeafTool(ctx(), call('propose_leaf', { title: 'Write the client', persona: 'Coder' }));

    const [leaf] = await leavesOnBranch();
    expect(leaf!.personaId).toBe('p-coder');
  });

  it('matches case-insensitively, since the model retypes the name', async () => {
    await db.savePersona(persona());
    await runLeafTool(ctx(), call('propose_leaf', { title: 'x', persona: '  coder ' }));
    expect((await leavesOnBranch())[0]!.personaId).toBe('p-coder');
  });

  it('keeps the leaf when the persona name matches nothing', async () => {
    // Refusing would trade a real proposal for a spelling mistake. The work is still valid; it
    // just runs as the default configuration.
    const out = JSON.parse(await runLeafTool(ctx(), call('propose_leaf', { title: 'x', persona: 'Nobody' })));

    expect(out.error).toBeUndefined();
    const [leaf] = await leavesOnBranch();
    expect(leaf!.title).toBe('x');
    expect(leaf!.personaId).toBeUndefined();
  });

  it('will not assign another user’s persona', async () => {
    // getPersonas returns every user's; the owner filter is the only thing keeping them apart.
    await db.savePersona(persona({ ownerId: 'someone-else' }));
    await runLeafTool(ctx(), call('propose_leaf', { title: 'x', persona: 'Coder' }));

    expect((await leavesOnBranch())[0]!.personaId).toBeUndefined();
  });

  it('lists personas by name and purpose, and nothing else', async () => {
    // The model assigns by name. Its prompt and its knobs are not the model's business.
    await db.savePersona(persona({ overrides: { temperature: 0.1 }, systemPrompt: 'secret-ish' }));
    const out = JSON.parse(await runLeafTool(ctx(), call('list_personas')));

    expect(out.personas).toEqual([{ name: 'Coder', description: 'Writes code.' }]);
    expect(JSON.stringify(out)).not.toMatch(/secret-ish|temperature/);
  });
});

describe('dependency ordering', () => {
  it('resolves dependencies by title within the same turn', async () => {
    // The model proposes several leaves at once and cannot know the ids of ones it just created.
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
    /**
     * The drop is right; the silence was not. `propose_leaf` reported plain success, so a model
     * that paraphrased its own title by one word believed it had built a chain and had actually
     * built a fan-out — every step starting at once against work that did not exist yet.
     */
    await runLeafTool(ctx(), call('propose_leaf', { title: 'Build the client' }));
    const out = JSON.parse(await runLeafTool(ctx(), call('propose_leaf', {
      title: 'Test it', dependsOn: ['Build an client'],
    })));

    expect(out.proposed).toBeTruthy();
    expect(out.unresolvedDependencies).toEqual(['Build an client']);
    // Says the consequence, not just the fact — this leaf will now start immediately.
    expect(out.warning).toMatch(/start immediately/i);
    // The real titles come back so the next call can name one correctly instead of guessing.
    expect(out.existingTitles).toContain('Build the client');
  });

  it('confirms the dependencies it DID record, by title', async () => {
    // An id the model has never seen tells it nothing; the title is what it can check against its
    // own plan.
    await runLeafTool(ctx(), call('propose_leaf', { title: 'Build the client' }));
    const out = JSON.parse(await runLeafTool(ctx(), call('propose_leaf', {
      title: 'Test it', dependsOn: ['Build the client'],
    })));

    expect(out.dependsOn).toEqual(['Build the client']);
    expect(out.warning).toBeUndefined();
  });

  it('says nothing about dependencies when none were asked for', async () => {
    // A leaf with no ordering must not read as one whose ordering was lost.
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
    // A cycle does not fail — everything in it waits forever, which looks like slow work.
    await runLeafTool(ctx(), call('propose_leaf', { title: 'A' }));
    await runLeafTool(ctx(), call('propose_leaf', { title: 'B', dependsOn: ['A'] }));
    const b = (await leavesOnBranch()).find((l) => l.title === 'B')!;
    await db.saveLeaf({ ...b, title: 'B' });

    // A depending on B would close the loop A -> B -> A.
    const a = (await leavesOnBranch()).find((l) => l.title === 'A')!;
    await db.saveLeaf({ ...a, dependsOn: [b.id] });
    const out = JSON.parse(await runLeafTool(ctx(), call('propose_leaf', { title: 'C', dependsOn: ['B'] })));

    // C -> B is fine; the guard only fires on an actual cycle.
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
    // A tool that throws would otherwise fail the whole turn, losing the reply already streamed.
    const boom = ctx({ webSearch: async () => { throw new Error('network is off'); } });
    const out = JSON.parse(await runLeafTool(boom, call('web_search', { query: 'x' })));
    expect(out.error).toMatch(/network is off/);
  });
});
