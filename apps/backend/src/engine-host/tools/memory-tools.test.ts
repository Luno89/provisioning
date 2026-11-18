import { containing } from '../../platform/lib/test-matchers.js';
import { describe, it, expect, beforeEach } from 'vitest';
import type { ToolHandlerContext } from '@koala/engine-core';
import type { MemoryItem } from '../drivers/memory-store.js';
import { createMemoryTools, matchMemories, searchAnswer } from './memory-tools.js';
import { MEMORY_TOOLS } from './memory-tools-catalogue.js';
import { interceptHttp, http, HttpResponse } from '../../platform/testing/http.js';
import { unindexerFrom } from '../../memory/lib/memory-index.js';
import { pointId } from '../../engine/lib/corpus-backend.js';

let bank: Map<string, MemoryItem>;
let ids: number;
let unindexed: { ownerId: string; ids: string[]; liveThen: boolean[] }[];
let indexRefuses: string | undefined;

const memory = (over: Partial<MemoryItem>): MemoryItem => ({
  id: 'm1', ownerId: 'u1', category: 'environment_facts', scope: 'global', status: 'active',
  title: 'DNS lives at Cloudflare', text: 'The person manages DNS for their domain at Cloudflare.', createdAt: 'then', updatedAt: 'then', ...over,
});

const tools = () => createMemoryTools({
  agents: async () => ['koala', 'executor'],
  models: async () => ['qwen/q', 'old/m'],
  tools: async () => ({ tools: ['start_task', 'mark_done'], servers: [{ name: 'playwright', tools: ['browser_click', 'browser_snapshot'] }] }),
  store: {
    list: async (ownerId) => [...bank.values()].filter((item) => item.ownerId === ownerId),
    save: async (item) => { bank.set(item.id, item); },
    unindex: async (ownerId, gone) => {
      if (indexRefuses) throw new Error(indexRefuses);
      unindexed.push({ ownerId, ids: gone, liveThen: gone.map((id) => !bank.get(id)?.invalidAt) });
    },
  },
  sourcesOf: async (runId) => (runId === 'run-web' ? { classes: ['web'], hosts: ['some.example'], runs: ['run-web'] } : undefined),
  now: () => 'now',
  newId: () => `new-${++ids}`,
});

const call = (name: string, parsed: Record<string, unknown>, caller: Record<string, unknown> = { ownerId: 'u1', runId: 'run-k' }) =>
  tools()[name]!({ name, parsed, driver: undefined, caller } as ToolHandlerContext);

beforeEach(() => {
  bank = new Map([['m1', memory({})], ['m2', memory({ id: 'm2', ownerId: 'someone-else', title: 'Their DNS', text: 'Cloudflare for them too.' })]]);
  ids = 0;
  unindexed = [];
  indexRefuses = undefined;
});

describe('search_memories', () => {
  it('finds the person\'s own current memories by the words in them, best match first', async () => {
    const out = await call('search_memories', { query: 'which DNS provider, cloudflare?' });

    expect(out.ok).toBe(true);
    expect(out.content).toContain('id m1 [environment_facts, global] DNS lives at Cloudflare');
    expect(out.content).not.toContain('m2');
  });

  it('does not find a retired memory', () => {
    expect(matchMemories([memory({ invalidAt: 'then' })], 'cloudflare')).toEqual([]);
  });
});

describe('save_memory', () => {
  it('saves a new memory, global when there is no project, noting the run that saved it', async () => {
    const out = await call('save_memory', { title: 'Trials last a week', text: 'Pool trials last 7 days.', category: 'prompt_guidance' });

    expect(out).toMatchObject({ ok: true, content: 'Saved as new-1.' });
    expect(bank.get('new-1')).toMatchObject({ ownerId: 'u1', scope: 'global', category: 'prompt_guidance', source: 'agent_tool', provenance: { experimentId: 'run-k' } });
  });

  it('keeps what the saving run read as the memory\'s sources', async () => {
    await call('save_memory', { text: 'Builds are cached for a day.' }, { ownerId: 'u1', runId: 'run-web' });
    expect(bank.get('new-1')!.provenance).toEqual({ experimentId: 'run-web', sources: { classes: ['web'], hosts: ['some.example'], runs: ['run-web'] } });
    await call('propose_practice', { agent: 'executor', text: 'Check the cache first.', why: 'run r-9' }, { ownerId: 'u1', runId: 'run-web' });
    expect([...bank.values()].find((item) => item.category === 'practice')?.provenance?.sources?.hosts).toEqual(['some.example']);
  });

  it('scopes it to the project the run works on, when asked', async () => {
    await call('save_memory', { text: 'The app listens on 3000.', scope: 'project' }, { ownerId: 'u1', projectId: 'p1' });
    expect(bank.get('new-1')).toMatchObject({ scope: 'project', projectId: 'p1' });
  });

  it('does not store the same thing twice', async () => {
    const out = await call('save_memory', { title: 'DNS lives at Cloudflare', text: 'The person manages DNS for their domain  at Cloudflare.' });

    expect(out).toMatchObject({ ok: true, content: 'That is already remembered as m1; nothing new was stored.' });
    expect(bank.size).toBe(2);
  });

  it('replaces a memory it updates, retiring the old one in favour of the new', async () => {
    const out = await call('save_memory', { title: 'DNS moved to Route 53', text: 'The person moved DNS from Cloudflare to Route 53.', replaces: 'm1' });

    expect(out.content).toBe('Saved as new-1, replacing m1.');
    expect(bank.get('m1')).toMatchObject({ invalidAt: 'now', supersededBy: 'new-1' });
  });

  it('takes the memory it replaces out of the index before retiring it', async () => {
    await call('save_memory', { title: 'DNS moved to Route 53', text: 'The person moved DNS from Cloudflare to Route 53.', replaces: 'm1' });

    expect(unindexed).toEqual([{ ownerId: 'u1', ids: ['m1'], liveThen: [true] }]);
  });

  it('saves nothing when the index will not let go of the memory it replaces, and says why', async () => {
    indexRefuses = 'Qdrant refused: HTTP 503 overloaded';
    await expect(call('save_memory', { title: 'DNS moved', text: 'Route 53 now.', replaces: 'm1' })).rejects.toThrow('Qdrant refused: HTTP 503 overloaded');

    expect(bank.get('m1')!.invalidAt).toBeUndefined();
    expect(bank.has('new-1')).toBe(false);
  });

  it('refuses to replace a memory that is not the person\'s, and saves nothing', async () => {
    expect((await call('save_memory', { text: 'x', replaces: 'm2' })).ok).toBe(false);
    expect(bank.size).toBe(2);
  });
});

describe('a memory kept for one model', () => {
  it('is saved for the model the keeper names, and found as such', async () => {
    const out = await call('save_memory', { title: 'Arguments as objects', text: 'It sends nested arguments as JSON text; send them as objects.', category: 'lessons_learned', scope: 'global', model: 'qwen/q' });

    expect(out.ok).toBe(true);
    expect(out.digest).toBe('remembered Arguments as objects for qwen/q');
    expect(bank.get('new-1')).toMatchObject({ model: 'qwen/q', scope: 'global' });
    expect((await call('search_memories', { query: 'nested arguments' })).content).toContain('[lessons_learned, global, only for qwen/q] Arguments as objects');
  });

  it('is refused for a model the person does not have, saying which they do', async () => {
    const out = await call('save_memory', { text: 'Something.', model: 'made/up' });

    expect(out.ok).toBe(false);
    expect(out.content).toBe('"made/up" is not one of the person\'s models; name the model exactly as read_run shows it, or leave model out');
    expect(bank.has('new-1')).toBe(false);
  });

  it('is not the same memory as one that holds for every model', async () => {
    await call('save_memory', { title: 'DNS lives at Cloudflare', text: 'The person manages DNS for their domain at Cloudflare.', model: 'qwen/q', scope: 'global' });

    expect(bank.get('new-1')).toMatchObject({ model: 'qwen/q' });
  });

  it('can be a practice, tried and given on that model only', async () => {
    const out = await call('propose_practice', { agent: 'executor', text: 'Quote paths with spaces.', why: 'run r-3', model: 'old/m' });

    expect(out.content).toBe('Proposed new-1 for executor on old/m; it is on trial until the bench has run executor\'s scenarios with it on old/m.');
    expect(bank.get('new-1')).toMatchObject({ category: 'practice', agent: 'executor', model: 'old/m', status: 'trial' });
    expect((await call('propose_practice', { agent: 'executor', text: 'Quote paths with spaces.', why: 'run r-3', model: 'nope' })).ok).toBe(false);
  });
});

describe('forget_memory', () => {
  it('retires a memory that is no longer true, keeping it and why', async () => {
    const out = await call('forget_memory', { id: 'm1', why: 'they said they never used Cloudflare' });

    expect(out.ok).toBe(true);
    expect(bank.get('m1')).toMatchObject({ invalidAt: 'now' });
    expect(bank.get('m1')!.text).toContain('(retired: they said they never used Cloudflare)');
  });

  it('takes a memory out of the index before retiring it, so it is never found again', async () => {
    await call('forget_memory', { id: 'm1', why: 'they said they never used Cloudflare' });

    expect(unindexed).toEqual([{ ownerId: 'u1', ids: ['m1'], liveThen: [true] }]);
  });

  it('keeps a memory the index will not let go of current, and says why', async () => {
    indexRefuses = 'Qdrant "vectors" is deployed but not answering: its pod is not ready';
    await expect(call('forget_memory', { id: 'm1', why: 'wrong' })).rejects.toThrow('Qdrant "vectors" is deployed but not answering');

    expect(bank.get('m1')!.invalidAt).toBeUndefined();
  });

  it('will not touch someone else\'s memory', async () => {
    expect((await call('forget_memory', { id: 'm2', why: 'no' })).ok).toBe(false);
    expect(unindexed).toEqual([]);
  });
});

describe('propose_practice', () => {
  it('puts a practice for one agent on trial, noting what it was learned from', async () => {
    const out = await call('propose_practice', { agent: 'koala', title: 'Check infrastructure first', text: 'Call list_infrastructure before saying what is deployed.', why: 'corrected in conversation c-7' });

    expect(out.ok).toBe(true);
    expect(bank.get('new-1')).toMatchObject({ category: 'practice', agent: 'koala', status: 'trial', title: 'Check infrastructure first', provenance: { experimentId: 'run-k' } });
    expect(bank.get('new-1')!.text).toContain('(learned from: corrected in conversation c-7)');
  });

  it('will not propose a practice for an agent that does not exist, or one the agent already has', async () => {
    expect((await call('propose_practice', { agent: 'nobody', text: 'x', why: 'y' })).content).toBe('there is no agent called "nobody"');
    await call('propose_practice', { agent: 'koala', text: 'Call list_infrastructure first.', why: 'y' });
    bank.set('new-1', { ...bank.get('new-1')!, text: 'Call list_infrastructure first.' });
    expect((await call('propose_practice', { agent: 'koala', text: 'Call list_infrastructure first.', why: 'again' })).ok).toBe(false);
  });
});

describe('propose_tool_note', () => {
  it('puts a note on a built-in tool on trial, kept for the model that misuses it, with what it was learned from', async () => {
    const out = await call('propose_tool_note', { tool: 'start_task', text: 'It claims the task; task_status first is not needed.', why: 'runs r1 and r2 called task_status instead', model: 'qwen/q' });

    expect(out.ok).toBe(true);
    expect(out.content).toBe('Proposed new-1 for start_task on qwen/q; it is on trial until the bench has run the checks that use it on qwen/q.');
    expect(bank.get('new-1')).toMatchObject({ category: 'tool_note', tool: 'start_task', model: 'qwen/q', status: 'trial', text: 'It claims the task; task_status first is not needed.', why: 'runs r1 and r2 called task_status instead', provenance: { experimentId: 'run-k' } });
    expect(bank.get('new-1')).not.toHaveProperty('server');
  });

  it('keeps a note on one tool of a server, named as it is offered, under the server, and one on a whole server', async () => {
    expect((await call('propose_tool_note', { tool: 'playwright__browser_click', text: 'Click by ref.', why: 'r3' })).ok).toBe(true);
    expect(bank.get('new-1')).toMatchObject({ server: 'playwright', tool: 'browser_click' });

    expect((await call('propose_tool_note', { server: 'playwright', text: 'Snapshot after every navigation.', why: 'r4' })).content).toContain('for the playwright server');
    expect(bank.get('new-2')).toMatchObject({ server: 'playwright' });
    expect(bank.get('new-2')).not.toHaveProperty('tool');
  });

  it('refuses a tool or server that does not exist, both at once, and the same note twice', async () => {
    expect((await call('propose_tool_note', { tool: 'made_up', text: 'x', why: 'y' })).content).toBe('there is no tool called "made_up"; name it exactly as it is offered');
    expect((await call('propose_tool_note', { tool: 'playwright__browser_fly', text: 'x', why: 'y' })).content).toBe('there is no tool called "playwright__browser_fly"; name it exactly as it is offered');
    expect((await call('propose_tool_note', { server: 'gitea', text: 'x', why: 'y' })).content).toBe('there is no MCP server called "gitea"');
    expect((await call('propose_tool_note', { tool: 'start_task', server: 'playwright', text: 'x', why: 'y' })).ok).toBe(false);
    expect((await call('propose_tool_note', { tool: 'start_task', text: 'x' })).content).toBe('give the note and what it was learned from');

    expect((await call('propose_tool_note', { tool: 'start_task', text: 'Claim first.', why: 'r1' })).ok).toBe(true);
    const again = await call('propose_tool_note', { tool: 'start_task', text: 'claim  first.', why: 'r2' });
    expect(again.content).toBe('start_task already has that note (new-1, trial); nothing was proposed');
    expect((await call('propose_tool_note', { tool: 'start_task', text: 'Claim first.', why: 'r2', model: 'qwen/q' })).ok).toBe(true);
  });
});

describe('the memory tools as declared', () => {
  it('are a read, proposals and two writes that destroy nothing, since a retired memory is kept', () => {
    expect(MEMORY_TOOLS.map((tool) => [tool.name, tool.effect, tool.destructive ?? null])).toEqual([
      ['search_memories', 'read', null],
      ['save_memory', 'write', false],
      ['propose_practice', 'propose', null],
      ['propose_tool_note', 'propose', null],
      ['forget_memory', 'write', false],
    ]);
  });
});

describe('the answer to a memory search, as an agent on a machine gets it', () => {
  it('lists what matches, says when nothing does, and leaves out what is retired', () => {
    const memories = [
      memory({ id: 'a', title: 'Odoo 20 access', text: 'Access rules are ir.access rows.' }),
      memory({ id: 'b', title: 'Old access note', text: 'Access rules are ir.model.access rows.', invalidAt: '2026-10-01T00:00:00Z' }),
    ];
    expect(searchAnswer(memories, 'access rules')).toEqual({ found: 1, text: containing('Odoo 20 access: Access rules are ir.access rows.') });
    expect(searchAnswer(memories, 'payroll')).toEqual({ found: 0, text: 'Nothing remembered matches "payroll".' });
  });
});

describe('retiring a memory from the person\'s own Quickwit and Qdrant', () => {
  const QUICKWIT = 'http://quickwit.memory-tools.test:7280';
  const QDRANT = 'http://qdrant.memory-tools.test:6333';
  const server = interceptHttp();
  const withIndex = () => createMemoryTools({
    store: {
      list: async (ownerId) => [...bank.values()].filter((item) => item.ownerId === ownerId),
      save: async (item) => { bank.set(item.id, item); },
      unindex: unindexerFrom(async () => ({ index: { base: QUICKWIT }, vectors: { base: QDRANT, apiKey: 'k' } })),
    },
    now: () => 'now',
    newId: () => `new-${++ids}`,
  });
  const callWithIndex = (name: string, parsed: Record<string, unknown>) =>
    withIndex()[name]!({ name, parsed, driver: undefined, caller: { ownerId: 'u1', runId: 'run-k' } } as ToolHandlerContext);
  const asking = (qdrant: () => Response = () => HttpResponse.json({ result: {} })) => {
    const asked: string[] = [];
    server.use(
      http.post(`${QUICKWIT}/api/v1/:index/delete-tasks`, async ({ request }) => { asked.push(`quickwit ${await request.text()}`); return HttpResponse.json({ opstamp: 1 }); }),
      http.post(`${QDRANT}/collections/:collection/points/delete`, async ({ request }) => { asked.push(`qdrant ${await request.text()}`); return qdrant(); }),
    );
    return asked;
  };

  it('forgetting a memory takes it out of both, then retires it', async () => {
    const asked = asking();

    expect(await callWithIndex('forget_memory', { id: 'm1', why: 'moved to Porkbun' })).toMatchObject({ ok: true, content: 'Retired m1.' });

    expect(asked).toEqual([`quickwit ${JSON.stringify({ query: 'memory_id:"m1"' })}`, `qdrant ${JSON.stringify({ points: [pointId('m1')] })}`]);
    expect(bank.get('m1')).toMatchObject({ invalidAt: 'now' });
  });

  it('a memory Qdrant will not let go of stays current, saying Qdrant\'s answer', async () => {
    asking(() => HttpResponse.text('collection is read-only', { status: 403 }));

    await expect(callWithIndex('forget_memory', { id: 'm1', why: 'moved to Porkbun' })).rejects.toThrow('Qdrant refused: HTTP 403 collection is read-only');

    expect(bank.get('m1')!.invalidAt).toBeUndefined();
  });

  it('replacing a memory takes the old one out of both before the new one is saved', async () => {
    const asked = asking();

    expect(await callWithIndex('save_memory', { title: 'DNS lives at Porkbun', text: 'The person moved their DNS to Porkbun.', category: 'environment_facts', replaces: 'm1' })).toMatchObject({ ok: true, content: 'Saved as new-1, replacing m1.' });

    expect(asked).toEqual([`quickwit ${JSON.stringify({ query: 'memory_id:"m1"' })}`, `qdrant ${JSON.stringify({ points: [pointId('m1')] })}`]);
    expect(bank.get('m1')).toMatchObject({ invalidAt: 'now', supersededBy: 'new-1' });
  });
});
