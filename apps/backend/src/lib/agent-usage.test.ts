import { describe, it, expect } from 'vitest';
import { agentUsage, agentsNamedIn } from './agent-usage.js';

const node = (id: string, kind: string, settings: Record<string, unknown> = {}, group?: string) => ({ id, kind, settings, position: { x: 0, y: 0 }, ...(group ? { group } : {}) });
const procedure = (id: string, nodes: ReturnType<typeof node>[], groups: unknown[] = []) => ({ id, nodes, groups }) as never;

describe('how each agent is used', () => {
  it('finds the agents a procedure delegates to, inside its groups too', () => {
    expect(agentsNamedIn(procedure('p', [node('a', 'delegate', { agent: 'planner' }), node('g', 'group', {}, 'work')], [
      { id: 'work', title: '', describe: '', inputs: [], outputs: [], exits: [], nodes: [node('b', 'fan-out', { agent: 'executor' })], wires: [], flow: [], groups: [] },
    ]))).toEqual(['executor', 'planner']);
  });

  it('says who chats with it, what the platform runs it for, which tree types grow with it, which procedures and agents hand it work', () => {
    const usage = agentUsage({
      agents: [
        { slug: 'koala', procedure: 'interactive-chat', agents: ['research'] },
        { slug: 'agent-builder', procedure: 'interactive-chat' },
        { slug: 'memory-keeper', procedure: 'keep-memory' },
        { slug: 'grove', procedure: 'grove-run' },
        { slug: 'planner', procedure: 'plan' },
        { slug: 'research', procedure: 'research-loop' },
        { slug: 'mine', procedure: 'tool-rounds' },
      ],
      procedures: [procedure('delivery', [node('a', 'delegate', { agent: 'planner' })])],
      treeTypes: [{ id: 'default', label: 'Default' }, { id: 'paper', label: 'Paper', agent: 'grove-paper' }],
    });

    expect(usage.get('koala')).toEqual([{ kind: 'chat', by: 'every new conversation' }]);
    expect(usage.get('agent-builder')).toEqual([{ kind: 'chat', by: 'conversations started with it' }, { kind: 'platform', by: 'makes the procedure changes you hand it' }]);
    expect(usage.get('memory-keeper')).toEqual([{ kind: 'platform', by: 'remembers what concluded conversations, judged work and failed runs leave' }]);
    expect(usage.get('grove')).toEqual([{ kind: 'tree-type', by: 'Default' }]);
    expect(usage.get('planner')).toEqual([{ kind: 'procedure', by: 'delivery' }]);
    expect(usage.get('research')).toEqual([{ kind: 'hand-off', by: 'koala' }]);
    expect(usage.get('mine')).toEqual([]);
    expect(usage.has('grove-paper')).toBe(false);
  });
});
