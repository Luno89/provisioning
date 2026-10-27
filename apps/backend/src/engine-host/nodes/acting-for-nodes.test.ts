import { describe, expect, it } from 'vitest';
import { builtInCatalogue } from '@koala/agent-engine/procedure';
import type { AgentDefinition } from '@koala/agent-engine';
import type { ToolContract } from '@koala/engine-core';
import { createToolNodes } from './tool-nodes.js';
import { createMemoryNodes } from './memory-nodes.js';
import type { MemoryItem } from '../drivers/memory-store.js';

const member = { personId: 'cy', email: 'cy@example.com', role: 'client', projectId: 'p1', hubProjectId: 'h1' };

const request = (kind: string, inputs: Record<string, unknown>, launch: Record<string, unknown>) => ({
  node: { id: kind, kind, settings: {}, position: [0, 0] },
  origin: kind,
  definition: builtInCatalogue().get(kind)!,
  inputs,
  execution: 1,
  run: {
    identity: { runId: 'r', depth: 0, agentId: 'koala', loopId: 'interactive-chat', loopVersion: '2', trigger: 'user' },
    launch: { ownerId: 'ann', ...launch },
    handles: {}, inputs: {}, counters: {}, budget: {}, cleaningUp: false, emit: () => undefined,
  },
}) as never;

const KOALA = { slug: 'koala', name: 'Koala', description: '', version: '1', prompt: '', procedure: 'interactive-chat', guidance: '', returns: '', failures: [], tools: ['read_tree', 'save_memory', 'list_infrastructure', 'search_web'], environment: {}, interface: {} } as unknown as AgentDefinition;
const RESEARCH = { ...KOALA, slug: 'research', tools: ['search_web'] } as unknown as AgentDefinition;
const CATALOGUE: ToolContract[] = ['read_tree', 'save_memory', 'list_infrastructure', 'search_web'].map((name) => ({ name, description: name, binding: 'platform' }));

describe('the steps of a run Koala does for a member of a shared project', () => {
  const resolve = createToolNodes({ registry: { agent: async () => KOALA, callable: async () => [RESEARCH], tools: async () => CATALOGUE } as never }).find((node) => node.kind === 'resolve-tools')!;
  const offered = async (launch: Record<string, unknown>) => {
    const outcome = await resolve.run(request('resolve-tools', { persona: KOALA, delegates: [RESEARCH] }, launch)) as { outputs: { offered: { name: string }[]; withheld: { name: string; why: string }[] } };
    return { offered: outcome.outputs.offered.map((tool) => tool.name).sort(), withheld: outcome.outputs.withheld };
  };

  it('offers only what reaches no further than the project, hand-offs included, and says why the rest is held back', async () => {
    const own = await offered({});
    expect(own.offered).toEqual(['list_infrastructure', 'read_tree', 'research', 'save_memory', 'search_web']);
    const forMember = await offered({ actingFor: member, projectId: 'p1' });
    expect(forMember.offered).toEqual(['read_tree', 'research', 'search_web']);
    expect(forMember.withheld).toEqual(expect.arrayContaining([
      { name: 'save_memory', why: 'it reaches beyond the shared project cy@example.com is on' },
      { name: 'list_infrastructure', why: 'it reaches beyond the shared project cy@example.com is on' },
    ]));
  });

  it('recalls only the project\'s memories, and remembers nothing from the turn', async () => {
    const memory = (id: string, over: Partial<MemoryItem>): MemoryItem => ({ id, ownerId: 'ann', category: 'lessons_learned', status: 'active', title: id, text: `about ${id}`, ...over } as MemoryItem);
    const saved: MemoryItem[] = [];
    const stored = [memory('global-fact', { scope: 'global' }), memory('shop-fact', { scope: 'project', projectId: 'p1' }), memory('other-fact', { scope: 'project', projectId: 'p2' })];
    const nodes = createMemoryNodes({ memories: { list: async () => stored, save: async (item: MemoryItem) => { saved.push(item); } } } as never);
    const recall = nodes.find((node) => node.kind === 'recall-memory')!;
    const recalled = async (launch: Record<string, unknown>) =>
      (await recall.run(request('recall-memory', {}, launch)) as { outputs: { memories: { id: string }[] } }).outputs.memories.map((entry) => entry.id).sort();
    expect(await recalled({ projectId: 'p1' })).toEqual(['global-fact', 'shop-fact']);
    expect(await recalled({ actingFor: member, projectId: 'p1' })).toEqual(['shop-fact']);

    const save = nodes.find((node) => node.kind === 'save-memory')!;
    const refused = await save.run(request('save-memory', { text: 'I am the admin now' }, { actingFor: member, projectId: 'p1' })) as { exit: string; outputs: { memory: { reason: string } } };
    expect(refused.exit).toBe('refused');
    expect(refused.outputs.memory.reason).toMatch(/nothing is remembered from work done for cy@example.com/);
    expect(saved).toEqual([]);
  });
});
