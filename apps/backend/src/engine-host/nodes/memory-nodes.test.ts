import { dnsMemory } from '../../memory/testing/memories.js';
import { describe, it, expect, beforeEach } from 'vitest';
import type { NodeImplementation } from '@koala/agent-engine/procedure';
import type { MemoryItem } from '../drivers/memory-store.js';
import { createMemoryNodes } from './memory-nodes.js';
import type { HostNodeServices } from './services.js';

let bank: Map<string, MemoryItem>;
let unindexed: string[];
let ids: number;

const memory = dnsMemory;

const step = (kind: string) => {
  const nodes = createMemoryNodes({
    memories: {
      list: async (ownerId: string) => [...bank.values()].filter((item) => item.ownerId === ownerId),
      save: async (item: MemoryItem) => { bank.set(item.id, item); },
      unindex: async (_ownerId: string, gone: string[]) => { unindexed.push(...gone); },
    },
    now: () => 'now',
    newId: () => `new-${++ids}`,
  } as unknown as HostNodeServices);
  const found = nodes.find((node) => node.kind === kind) as Extract<NodeImplementation, { role: 'step' }>;
  return (inputs: Record<string, unknown>, settings: Record<string, unknown> = {}, launch: Record<string, unknown> = {}) => found.run({
    node: { id: kind, kind, settings },
    inputs,
    run: {
      identity: { runId: 'run-1', depth: 0, agentId: 'koala', trigger: 'user' },
      launch: { ownerId: 'u1', ...launch },
      budget: {},
      emit: () => undefined,
    },
  } as never);
};

beforeEach(() => {
  bank = new Map([['m1', memory({})], ['m2', memory({ id: 'm2', ownerId: 'someone-else', title: 'Their DNS', text: 'Cloudflare for them too.' })]]);
  unindexed = [];
  ids = 0;
});

describe('the Save Memory node', () => {
  it('saves what it is given, with the category and scope it is set to', async () => {
    const outcome = await step('save-memory')({ text: 'Builds run on the GPU box.' }, { category: 'environment_facts', scope: 'project' }, { projectId: 'p1' });

    expect(outcome).toMatchObject({ exit: 'saved' });
    expect(bank.get('new-1')).toMatchObject({ text: 'Builds run on the GPU box.', category: 'environment_facts', scope: 'project', projectId: 'p1', source: 'agent_tool' });
  });

  it('does not store the same thing twice, as the tool does not', async () => {
    const outcome = await step('save-memory')({ text: 'The person manages DNS for their domain at Cloudflare.', title: 'DNS lives at Cloudflare' });

    expect(outcome).toMatchObject({ exit: 'saved', outputs: { memory: { id: 'm1' } } });
    expect(bank.size).toBe(2);
  });

  it('keeps a memory for the model it is wired to, as the tool does', async () => {
    await step('save-memory')({ text: 'Send nested arguments as objects.', binding: { model: 'qwen/q' } });

    expect(bank.get('new-1')).toMatchObject({ model: 'qwen/q' });
  });

  it('refuses a project memory when the run has no project, saying why', async () => {
    const outcome = await step('save-memory')({ text: 'Only here.' }, { scope: 'project' });

    expect(outcome).toMatchObject({ exit: 'refused' });
    expect(bank.size).toBe(2);
  });
});

describe('the Update Memory node', () => {
  it('replaces a memory with what it is given, retiring the old one in favour of the new', async () => {
    const outcome = await step('update-memory')({ id: 'm1', text: 'DNS moved to Porkbun.' });

    expect(outcome).toMatchObject({ exit: 'updated', outputs: { memory: { id: 'new-1', text: 'DNS moved to Porkbun.' } } });
    expect(bank.get('m1')).toMatchObject({ invalidAt: 'now', supersededBy: 'new-1' });
    expect(unindexed).toEqual(['m1']);
  });

  it('refuses a memory that is not the person\'s, and changes nothing', async () => {
    const outcome = await step('update-memory')({ id: 'm2', text: 'Mine now.' });

    expect(outcome).toMatchObject({ exit: 'refused', outputs: { memory: { reason: 'there is no current memory m2 to replace; nothing was saved' } } });
    expect(bank.size).toBe(2);
  });
});

describe('the Forget Memory node', () => {
  it('retires a memory that is no longer true, keeping it and why', async () => {
    const outcome = await step('forget-memory')({ id: 'm1', why: 'the domain moved' });

    expect(outcome).toMatchObject({ exit: 'forgotten' });
    expect(bank.get('m1')).toMatchObject({ invalidAt: 'now', text: 'The person manages DNS for their domain at Cloudflare.\n(retired: the domain moved)' });
    expect(unindexed).toEqual(['m1']);
  });

  it('will not touch someone else\'s memory', async () => {
    const outcome = await step('forget-memory')({ id: 'm2', why: 'nope' });

    expect(outcome).toMatchObject({ exit: 'refused', outputs: { memory: { reason: 'there is no current memory m2' } } });
    expect(bank.get('m2')?.invalidAt).toBeUndefined();
  });
});
