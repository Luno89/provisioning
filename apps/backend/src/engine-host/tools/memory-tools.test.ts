import { describe, it, expect, beforeEach } from 'vitest';
import type { ToolHandlerContext } from '@koala/engine-core';
import type { MemoryItem } from '../drivers/memory-store.js';
import { createMemoryTools, matchMemories } from './memory-tools.js';
import { MEMORY_TOOLS } from './memory-tools-catalogue.js';

let bank: Map<string, MemoryItem>;
let ids: number;

const memory = (over: Partial<MemoryItem>): MemoryItem => ({
  id: 'm1', ownerId: 'u1', category: 'environment_facts', scope: 'global', status: 'active',
  title: 'DNS lives at Cloudflare', text: 'The person manages DNS for their domain at Cloudflare.', createdAt: 'then', updatedAt: 'then', ...over,
});

const tools = () => createMemoryTools({
  agents: async () => ['koala', 'executor'],
  store: {
    list: async (ownerId) => [...bank.values()].filter((item) => item.ownerId === ownerId),
    save: async (item) => { bank.set(item.id, item); },
  },
  now: () => 'now',
  newId: () => `new-${++ids}`,
});

const call = (name: string, parsed: Record<string, unknown>, caller: Record<string, unknown> = { ownerId: 'u1', runId: 'run-k' }) =>
  tools()[name]!({ name, parsed, driver: undefined, caller } as ToolHandlerContext);

beforeEach(() => {
  bank = new Map([['m1', memory({})], ['m2', memory({ id: 'm2', ownerId: 'someone-else', title: 'Their DNS', text: 'Cloudflare for them too.' })]]);
  ids = 0;
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

  it('refuses to replace a memory that is not the person\'s, and saves nothing', async () => {
    expect((await call('save_memory', { text: 'x', replaces: 'm2' })).ok).toBe(false);
    expect(bank.size).toBe(2);
  });
});

describe('forget_memory', () => {
  it('retires a memory that is no longer true, keeping it and why', async () => {
    const out = await call('forget_memory', { id: 'm1', why: 'they said they never used Cloudflare' });

    expect(out.ok).toBe(true);
    expect(bank.get('m1')).toMatchObject({ invalidAt: 'now' });
    expect(bank.get('m1')!.text).toContain('(retired: they said they never used Cloudflare)');
  });

  it('will not touch someone else\'s memory', async () => {
    expect((await call('forget_memory', { id: 'm2', why: 'no' })).ok).toBe(false);
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

describe('the memory tools as declared', () => {
  it('are a read, a proposal and two writes that destroy nothing, since a retired memory is kept', () => {
    expect(MEMORY_TOOLS.map((tool) => [tool.name, tool.effect, tool.destructive ?? null])).toEqual([
      ['search_memories', 'read', null],
      ['save_memory', 'write', false],
      ['propose_practice', 'propose', null],
      ['forget_memory', 'write', false],
    ]);
  });
});
