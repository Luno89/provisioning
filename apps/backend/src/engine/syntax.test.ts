import { describe, it, expect } from 'vitest';
import { formatLoop, parseSource } from './syntax.js';
import { graphErrors, validateGraph } from './graph.js';

const DELIVERY = `
loop delivery v4
  budget   rounds 20, tool-calls 60
  requires workspace
  entry    gather

  gather: tool list_tasks
    args
      ready true
    as tasks
    -> done when empty(tasks)
    -> each

  each: fanout
    over     {{tasks}}
    agent    executor
    join     landed
    parallel 3
    as       results

  landed: merge ok
    as survivors
    -> judge when not empty(survivors)
    -> done

  judge: agent judge
    inputs
      work {{survivors}}
    as verdict
    -> gather

  done: terminal ok
`;

const only = (source: string) => {
  const parsed = parseSource(source);
  expect(parsed.problems).toEqual([]);
  return parsed;
};

describe('parsing a loop', () => {
  it('reads the header, and strips the v from the version', () => {
    const { loops } = only(DELIVERY);

    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatchObject({ id: 'delivery', version: '4', entry: 'gather' });
  });

  it('reads a budget written as a comma list', () => {
    expect(only(DELIVERY).loops[0]?.budget).toEqual({ maxRounds: 20, maxToolCalls: 60 });
  });

  it('reads requirements as flags', () => {
    expect(only(DELIVERY).loops[0]?.requires).toEqual({ workspace: true });
  });

  it('puts the subject on the field that node is about', () => {
    const byId = Object.fromEntries(only(DELIVERY).loops[0]!.nodes.map((n) => [n.id, n]));

    expect(byId.gather).toMatchObject({ kind: 'tool', tool: 'list_tasks' });
    expect(byId.judge).toMatchObject({ kind: 'agent', agent: 'judge' });
    expect(byId.landed).toMatchObject({ kind: 'merge', strategy: 'ok' });
    expect(byId.done).toMatchObject({ kind: 'terminal', outcome: 'ok' });
  });

  it('reads a nested object, keeping templating untouched', () => {
    const byId = Object.fromEntries(only(DELIVERY).loops[0]!.nodes.map((n) => [n.id, n]));

    expect(byId.gather).toMatchObject({ args: { ready: true } });
    expect(byId.judge).toMatchObject({ inputs: { work: '{{survivors}}' } });
  });

  it('renames fields that read better in text than in the object', () => {
    const each = only(DELIVERY).loops[0]!.nodes.find((n) => n.id === 'each');

    expect(each).toMatchObject({ kind: 'fanout', over: '{{tasks}}', agent: 'executor', maxParallel: 3 });
  });

  it('keeps edges in the order written, because first match wins', () => {
    const gather = only(DELIVERY).loops[0]!.nodes.find((n) => n.id === 'gather');

    expect(gather?.next).toEqual([
      { to: 'done', when: 'empty(tasks)' },
      { to: 'each' },
    ]);
  });

  it('produces a graph the compiler accepts', () => {
    const { loops } = only(DELIVERY);
    const problems = graphErrors(validateGraph(loops[0]!, {
      agents: new Set(['executor', 'judge']),
      tools: new Set(['list_tasks']),
    }));

    expect(problems).toEqual([]);
  });

  it('defaults the entry to the first node when none is named', () => {
    const { loops } = only(`
loop tiny v1
  first: terminal ok
`);

    expect(loops[0]?.entry).toBe('first');
  });
});

describe('parsing an agent', () => {
  const SOURCE = `
agent spec-author v2
  describe Drafts a deployable app spec and proposes it
  loop     tool-rounds
  needs    egress
  tools    list_infrastructure, propose_spec
  agents   research
  outputs  spec, rationale
  budget   rounds 8
  egress   request
  prompt >
    You draft specs for apps this platform cannot deploy.
    Check what exists first.
`;

  it('reads every header field', () => {
    const { agents } = only(SOURCE);

    expect(agents[0]).toMatchObject({
      slug: 'spec-author',
      version: '2',
      description: 'Drafts a deployable app spec and proposes it',
      loop: 'tool-rounds',
      tools: ['list_infrastructure', 'propose_spec'],
      agents: ['research'],
      budget: { maxRounds: 8 },
      egressMode: 'request',
      environment: { egress: true },
      interface: { outputs: ['spec', 'rationale'] },
    });
  });

  it('keeps a prompt block as written, over multiple lines', () => {
    expect(only(SOURCE).agents[0]?.prompt)
      .toBe('You draft specs for apps this platform cannot deploy.\nCheck what exists first.');
  });

  it('marks an agent that needs a workspace as pinned to one', () => {
    const { agents } = only(`
agent builder v1
  loop  tool-rounds
  needs terminal, filesystem, workspace
`);

    expect(agents[0]?.environment).toMatchObject({ terminal: true, workspace: true });
    expect(agents[0]?.interface?.workspace).toBe(true);
  });

  it('reads an agent and a loop out of one file', () => {
    const parsed = only(`${DELIVERY}\nagent runner v1\n  loop delivery\n`);

    expect(parsed.loops).toHaveLength(1);
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.agents[0]?.loop).toBe('delivery');
  });
});

describe('what the author is told when it is wrong', () => {
  const problems = (source: string) => parseSource(source).problems;

  it('points at the line with a bad indent', () => {
    expect(problems('loop a v1\n   entry x\n')).toEqual([
      { line: 2, message: 'indent in steps of 2 spaces (found 3)' },
    ]);
  });

  it('refuses tabs rather than guessing the width', () => {
    expect(problems('loop a v1\n\tentry x\n')[0]?.message).toBe('indent with spaces, not tabs');
  });

  it('names the node kinds when one is misspelled', () => {
    const found = problems('loop a v1\n  x: modell\n')[0];

    expect(found?.line).toBe(2);
    expect(found?.message).toContain('is not a node kind');
    expect(found?.message).toContain('fanout');
  });

  it('rejects a subject on a node that has none', () => {
    expect(problems('loop a v1\n  x: dispatch something\n')[0]?.message)
      .toContain('a dispatch node takes no subject');
  });

  it('catches an unknown setting rather than dropping it silently', () => {
    expect(problems('loop a v1\n  entry x\n  speed fast\n')[0]?.message)
      .toBe('a loop has no "speed" setting');

    expect(problems('agent a v1\n  vibe good\n')[0]?.message)
      .toBe('an agent has no "vibe" setting');
  });

  it('says an edge needs a target', () => {
    expect(problems('loop a v1\n  x: model\n    ->\n')[0]?.message)
      .toBe('an edge needs a target node');
  });

  it('rejects anything but loop or agent at the margin', () => {
    expect(problems('persona a v1\n')[0]?.message).toContain('is not a block');
  });

  it('ignores comments and blank lines', () => {
    const { loops } = only(`
# the delivery loop
loop a v1

  entry x        # where it starts
  x: terminal ok
`);

    expect(loops[0]).toMatchObject({ id: 'a', entry: 'x' });
  });
});

describe('round-tripping', () => {
  it('formats a parsed loop back to text that parses the same', () => {
    const first = only(DELIVERY).loops[0]!;
    const second = only(formatLoop(first)).loops[0]!;

    expect(second).toEqual(first);
  });

  it('survives a second pass unchanged, so the canvas cannot drift the text', () => {
    const once = formatLoop(only(DELIVERY).loops[0]!);
    const twice = formatLoop(only(once).loops[0]!);

    expect(twice).toBe(once);
  });
});
