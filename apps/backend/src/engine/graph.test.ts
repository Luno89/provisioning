import { describe, it, expect } from 'vitest';
import { BUILT_IN_REDUCERS, graphErrors, validateGraph, type LoopGraph } from './graph.js';

const graph = (over: Partial<LoopGraph> = {}): LoopGraph => ({
  id: 'test-loop',
  version: '1',
  entry: 'ask',
  nodes: [
    { kind: 'model', id: 'ask', next: [{ to: 'done' }] },
    { kind: 'terminal', id: 'done', outcome: 'ok' },
  ],
  ...over,
});

const messages = (g: LoopGraph, known?: Parameters<typeof validateGraph>[1]) =>
  validateGraph(g, known).map((problem) => problem.message);

describe('validateGraph', () => {
  it('accepts a minimal well-formed loop', () => {
    expect(validateGraph(graph())).toEqual([]);
  });

  it('rejects an empty loop', () => {
    expect(messages(graph({ nodes: [] }))).toEqual(['a loop needs at least one node']);
  });

  it('rejects a missing entry node', () => {
    expect(messages(graph({ entry: 'nowhere' }))).toContain('the entry node "nowhere" does not exist');
  });

  it('rejects an edge pointing at a node that does not exist', () => {
    const broken = graph({
      nodes: [
        { kind: 'model', id: 'ask', next: [{ to: 'ghost' }] },
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    });
    expect(messages(broken)).toContain('points at "ghost", which does not exist');
  });

  it('rejects duplicate node ids', () => {
    const dupe = graph({
      nodes: [
        { kind: 'model', id: 'ask', next: [{ to: 'done' }] },
        { kind: 'model', id: 'ask', next: [{ to: 'done' }] },
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    });
    expect(messages(dupe)).toContain('two nodes share the id "ask"');
  });

  it('rejects a non-terminal node with nowhere to go', () => {
    const stuck = graph({
      nodes: [
        { kind: 'model', id: 'ask' },
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    });
    expect(messages(stuck)).toContain('has nowhere to go and is not a terminal');
  });

  it('rejects a live node with no path to any terminal', () => {
    const noExit = graph({
      entry: 'a',
      budget: { maxRounds: 4 },
      nodes: [
        { kind: 'model', id: 'a', next: [{ to: 'b' }] },
        { kind: 'model', id: 'b', next: [{ to: 'a' }] },
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    });
    expect(messages(noExit)).toContain('no path from here ever reaches a terminal');
  });

  it('warns about a node nothing can reach', () => {
    const orphan = graph({
      nodes: [
        { kind: 'model', id: 'ask', next: [{ to: 'done' }] },
        { kind: 'model', id: 'stranded', next: [{ to: 'done' }] },
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    });
    const problems = validateGraph(orphan);
    expect(graphErrors(problems)).toEqual([]);
    expect(problems).toContainEqual({ severity: 'warning', nodeId: 'stranded', message: 'nothing can reach this node' });
  });

  it('rejects a cycle with no budget, and accepts the same cycle once bounded', () => {
    const cyclic = graph({
      nodes: [
        { kind: 'model', id: 'ask', next: [{ to: 'ask', when: 'empty(reply.content)' }, { to: 'done' }] },
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    });

    expect(messages(cyclic)).toContain(
      'this loop can cycle forever — give it a budget (rounds, tokens, tool calls or wall clock)',
    );
    expect(validateGraph({ ...cyclic, budget: { maxRounds: 6 } })).toEqual([]);
  });

  it('rejects a condition that does not parse', () => {
    const bad = graph({
      nodes: [
        { kind: 'model', id: 'ask', next: [{ to: 'done', when: 'counters.rounds $$ 2' }] },
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    });
    expect(messages(bad).some((m) => m.startsWith('condition "counters.rounds $$ 2" does not parse'))).toBe(true);
  });

  it('rejects references to agents and tools that are not available', () => {
    const refs = graph({
      entry: 'call',
      nodes: [
        { kind: 'agent', id: 'call', agent: 'ghost-agent', next: [{ to: 'tool' }] },
        { kind: 'tool', id: 'tool', tool: 'ghost-tool', next: [{ to: 'done' }] },
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    });

    const found = messages(refs, { agents: new Set(['research']), tools: new Set(['read_file']) });
    expect(found).toContain('calls agent "ghost-agent", which is not available here');
    expect(found).toContain('calls tool "ghost-tool", which is not available here');
  });

  it('accepts a merge with no strategy, and every built-in reducer', () => {
    for (const strategy of [undefined, ...BUILT_IN_REDUCERS]) {
      const merged = graph({
        entry: 'join',
        nodes: [
          { kind: 'merge', id: 'join', ...(strategy ? { strategy } : {}), next: [{ to: 'done' }] },
          { kind: 'terminal', id: 'done', outcome: 'ok' },
        ],
      });

      expect(messages(merged, { agents: new Set(), tools: new Set() })).toEqual([]);
    }
  });

  it('lets a merge strategy name a tool or an agent, and rejects one that is neither', () => {
    const withStrategy = (strategy: string) => graph({
      entry: 'join',
      nodes: [
        { kind: 'merge', id: 'join', strategy, next: [{ to: 'done' }] },
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    });

    const known = { agents: new Set(['conflict-resolver']), tools: new Set(['pick-newest']) };

    expect(messages(withStrategy('conflict-resolver'), known)).toEqual([]);
    expect(messages(withStrategy('pick-newest'), known)).toEqual([]);
    expect(messages(withStrategy('made-up'), known).join(' '))
      .toContain('which is not a built-in reducer');
  });

  it('checks a fan-out joins somewhere real', () => {
    const fan = graph({
      entry: 'spread',
      nodes: [
        { kind: 'fanout', id: 'spread', over: 'outputs.items', agent: 'worker', join: 'nowhere' },
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    });
    expect(messages(fan, { agents: new Set(['worker']) })).toContain('joins at "nowhere", which does not exist');
  });

  it('accepts a complete fan-out, merge and terminal path', () => {
    const fan = graph({
      entry: 'spread',
      nodes: [
        { kind: 'fanout', id: 'spread', over: 'outputs.items', agent: 'worker', join: 'join' },
        { kind: 'merge', id: 'join', next: [{ to: 'done' }] },
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    });
    expect(validateGraph(fan, { agents: new Set(['worker']) })).toEqual([]);
  });
});
