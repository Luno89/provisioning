import { dnsMemory } from '../../memory/testing/memories.js';
import { describe, it, expect, beforeEach } from 'vitest';
import type { NodeImplementation } from '@koala/agent-engine/procedure';
import type { MemoryItem } from '../drivers/memory-store.js';
import { createMemoryNodes } from './memory-nodes.js';
import { DependencyDownError } from '../../platform/index.js';
import type { HostNodeServices } from './services.js';

let bank: Map<string, MemoryItem>;
let unindexed: string[];
let ids: number;
let ranked: string[] | Error;
let asked: { ownerId: string; query: string; limit: number }[];
let notices: unknown[];
let indexed: string[];
let indexDown: Error | undefined;
const windows: Record<string, number> = { 'small/model': 2_000 };

const memory = dnsMemory;

const step = (kind: string) => {
  const nodes = createMemoryNodes({
    memories: {
      list: async (ownerId: string) => [...bank.values()].filter((item) => item.ownerId === ownerId),
      save: async (item: MemoryItem) => { bank.set(item.id, item); },
      index: async (items: MemoryItem[]) => {
        if (indexDown) throw indexDown;
        indexed.push(...items.map((item) => item.id));
      },
      unindex: async (_ownerId: string, gone: string[]) => { unindexed.push(...gone); },
      search: async (ownerId: string, query: string, limit: number) => {
        asked.push({ ownerId, query, limit });
        if (ranked instanceof Error) throw ranked;
        return ranked;
      },
    },
    models: {
      resolveBaseUrl: async (_ownerId: string, modelId?: string) => ({ provider: { id: 'p', name: 'P', ...(modelId && windows[modelId] ? { contextTokens: windows[modelId] } : {}) }, baseUrl: 'http://models.test/v1' }),
    },
    now: () => 'now',
    newId: () => `new-${++ids}`,
  } as unknown as HostNodeServices);
  const found = nodes.find((node) => node.kind === kind) as Extract<NodeImplementation, { role: 'step' }>;
  return (inputs: Record<string, unknown>, settings: Record<string, unknown> = {}, launch: Record<string, unknown> = {}, runInputs: Record<string, unknown> = {}) => found.run({
    node: { id: kind, kind, settings },
    inputs,
    run: {
      identity: { runId: 'run-1', depth: 0, agentId: 'koala', trigger: 'user' },
      launch: { ownerId: 'u1', ...launch },
      inputs: runInputs,
      budget: {},
      emit: (event: unknown) => { notices.push(event); },
    },
  } as never);
};

beforeEach(() => {
  bank = new Map([['m1', memory({})], ['m2', memory({ id: 'm2', ownerId: 'someone-else', title: 'Their DNS', text: 'Cloudflare for them too.' })]]);
  unindexed = [];
  ids = 0;
  ranked = [];
  asked = [];
  notices = [];
  indexed = [];
  indexDown = undefined;
});

describe('the Recall Memory node', () => {
  const task = { message: 'Which DNS provider do I use?' };
  const roomy = { binding: { contextTokens: 100_000 } };
  const recalledIds = async (inputs: Record<string, unknown>): Promise<string[]> =>
    ((await step('recall-memory')(inputs, {}, {}, task)) as unknown as { outputs: { memories: { id: string }[] } }).outputs.memories.map((recalled) => recalled.id);
  const gpuBox = memory({ id: 'm3', title: 'Builds run on the GPU box', text: 'Every build runs on the GPU box in the hall.', category: 'environment_facts' });

  it('recalls what the index finds most relevant to the run\'s task, in the index\'s order, asking for as many as the person has', async () => {
    bank.set('m3', gpuBox);
    ranked = ['m3', 'm1'];

    const outcome = await step('recall-memory')(roomy, {}, {}, task) as unknown as { outputs: { memories: { id: string }[]; text: string } };

    expect(asked).toEqual([{ ownerId: 'u1', query: 'Which DNS provider do I use?', limit: 2 }]);
    expect(outcome.outputs.memories.map((recalled) => recalled.id)).toEqual(['m3', 'm1']);
    expect(outcome.outputs.text).toContain('DNS lives at Cloudflare');
    expect(notices).toEqual([]);
  });

  it('takes as many of the most relevant as the model\'s context has room for', async () => {
    bank.set('m3', memory({ ...gpuBox, text: 'x'.repeat(5_000) }));
    ranked = ['m3', 'm1'];

    expect(await recalledIds({ binding: { contextTokens: 2_000 } })).toEqual(['m1']);
  });

  it('fits the run\'s own model\'s context when no model is wired to it', async () => {
    bank.set('m3', memory({ ...gpuBox, text: 'x'.repeat(5_000) }));
    ranked = ['m3', 'm1'];

    const outcome = await step('recall-memory')({}, {}, { modelId: 'small/model' }, task) as unknown as { outputs: { memories: { id: string }[] } };

    expect(outcome.outputs.memories.map((recalled) => recalled.id)).toEqual(['m1']);
  });

  it('refuses to guess a context size when neither a wired model nor the run\'s own names one', async () => {
    ranked = ['m1'];
    await expect(step('recall-memory')({}, {}, { modelId: 'quiet/model' }, task)).rejects.toThrow('memories are recalled to fit a model\'s context, and quiet/model reports no context size');
  });

  it('never recalls another person\'s memory or one that is retired, whatever the index finds', async () => {
    bank.set('m3', memory({ ...gpuBox, invalidAt: '2026-11-01T00:00:00.000Z' }));
    ranked = ['m2', 'm3', 'm1'];

    expect(await recalledIds(roomy)).toEqual(['m1']);
  });

  it('carries on without memories while the index is down, and the chat says so with since and why', async () => {
    ranked = new DependencyDownError('qdrant', '2026-11-21T10:00:00.000Z', 'its pod is not ready');

    const outcome = await step('recall-memory')(roomy, {}, {}, task);

    expect(outcome).toEqual({ outputs: { memories: [], text: '' } });
    expect(notices).toEqual([expect.objectContaining({
      type: 'notice',
      level: 'warn',
      message: 'This run goes on without its memories: the memory index\'s meanings (Qdrant) isn\'t answering since 10:00 UTC: its pod is not ready',
    })]);
  });
});

describe('the Point to Memories node, for an agent whose own loop manages its context', () => {
  const task = { message: 'Which DNS provider do I use?' };
  const pointed = async (inputs: Record<string, unknown> = {}): Promise<string> =>
    ((await step('point-to-memories')(inputs, {}, {}, task)) as unknown as { outputs: { text: string } }).outputs.text;

  it('names what memory holds for the task by title, most relevant first, and leaves the memories themselves to search_memories, needing no context size', async () => {
    bank.set('m3', memory({ id: 'm3', title: 'Builds run on the GPU box', text: 'Every build runs on the GPU box in the hall.' }));
    ranked = ['m3', 'm1'];

    const text = await pointed();

    expect(asked).toEqual([{ ownerId: 'u1', query: 'Which DNS provider do I use?', limit: 2 }]);
    expect(text).toContain('search_memories');
    expect(text.indexOf('Builds run on the GPU box')).toBeLessThan(text.indexOf(memory({}).title));
    expect(text).not.toContain('Every build runs on the GPU box in the hall.');
    expect(notices).toEqual([]);
  });

  it('asks the index for the task wired to it over the run\'s message', async () => {
    ranked = ['m1'];
    await pointed({ task: 'Where does mail go?' });
    expect(asked.map((one) => one.query)).toEqual(['Where does mail go?']);
  });

  it('names nothing of another person\'s, nothing retired and nothing kept for one model', async () => {
    bank.set('m3', memory({ id: 'm3', title: 'Retired fact', invalidAt: '2026-11-01T00:00:00.000Z' }));
    bank.set('m4', memory({ id: 'm4', title: 'Only for one model', model: 'small/model' }));
    ranked = ['m2', 'm3', 'm4', 'm1'];

    const text = await pointed();

    expect(text).toContain(memory({}).title);
    expect(text).not.toContain('Their DNS');
    expect(text).not.toContain('Retired fact');
    expect(text).not.toContain('Only for one model');
  });

  it('says memory holds nothing for the task when nothing is remembered, and still points to search_memories', async () => {
    bank = new Map();
    ranked = [];
    const text = await pointed();
    expect(text).toContain('Nothing remembered');
    expect(text).toContain('search_memories');
  });

  it('carries on while the index is down, and the chat and the agent are told so with since and why', async () => {
    ranked = new DependencyDownError('qdrant', '2026-11-21T10:00:00.000Z', 'its pod is not ready');

    const text = await pointed();

    expect(text).toContain('isn\'t answering since 10:00 UTC: its pod is not ready');
    expect(notices).toEqual([expect.objectContaining({
      type: 'notice',
      level: 'warn',
      message: 'This run goes on without its memories: the memory index\'s meanings (Qdrant) isn\'t answering since 10:00 UTC: its pod is not ready',
    })]);
  });
});

describe('the Save Memory node', () => {
  it('saves what it is given, with the category and scope it is set to', async () => {
    const outcome = await step('save-memory')({ text: 'Builds run on the GPU box.' }, { category: 'environment_facts', scope: 'project' }, { projectId: 'p1' });

    expect(outcome).toMatchObject({ exit: 'saved' });
    expect(bank.get('new-1')).toMatchObject({ text: 'Builds run on the GPU box.', category: 'environment_facts', scope: 'project', projectId: 'p1', source: 'agent_tool' });
    expect(indexed).toEqual(['new-1']);
  });

  it('saves while the index is down, and the chat says it is found once the index answers again', async () => {
    indexDown = new DependencyDownError('qdrant', '2026-11-21T10:00:00.000Z', 'its pod is not ready');

    const outcome = await step('save-memory')({ text: 'Builds run on the GPU box.' });

    expect(outcome).toMatchObject({ exit: 'saved' });
    expect(bank.get('new-1')?.indexPending).toBe(true);
    expect(notices).toEqual([expect.objectContaining({
      type: 'notice',
      level: 'warn',
      message: 'Saved, and found once the index answers again: the memory index\'s meanings (Qdrant) isn\'t answering since 10:00 UTC: its pod is not ready',
    })]);
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
