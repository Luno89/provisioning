import { describe, it, expect } from 'vitest';
import { compile, formatProblems } from './compile.js';

const known = {
  tools: new Set(['list_tasks', 'run_command']),
  agents: new Set(['executor', 'judge']),
  loops: new Set(['tool-rounds']),
};

const GOOD = `
loop delivery v1
  budget rounds 10
  entry gather

  gather: tool list_tasks
    as tasks
    -> work when not empty(tasks)
    -> done

  work: agent executor
    -> gather

  done: terminal ok

agent runner v1
  describe Runs the delivery loop
  loop     delivery
  tools    list_tasks
  agents   executor
`;

describe('compiling something correct', () => {
  it('reports nothing and hands back the loop and the agent', () => {
    const built = compile(GOOD, known);

    expect(built.problems).toEqual([]);
    expect(built.ok).toBe(true);
    expect(built.loops.map((loop) => loop.id)).toEqual(['delivery']);
    expect(built.agents.map((agent) => agent.slug)).toEqual(['runner']);
  });

  it('lets an agent run a loop defined in the same file', () => {
    expect(compile(GOOD, known).ok).toBe(true);
  });

  it('lets an agent run a loop that already exists elsewhere', () => {
    const built = compile('agent solo v1\n  loop tool-rounds\n', known);
    expect(built.ok).toBe(true);
  });
});

describe('what the author gets back when it is wrong', () => {
  const messages = (source: string) => compile(source, known).problems.map((p) => p.message);

  it('puts a line number on a typo the parser caught', () => {
    const built = compile('loop a v1\n   entry x\n', known);

    expect(built.ok).toBe(false);
    expect(built.problems).toContainEqual(
      expect.objectContaining({ line: 2, message: expect.stringContaining('indent in steps of 2') }),
    );
  });

  it('puts a line number on a problem the validator caught, pointing at the node', () => {
    const built = compile(`
loop a v1
  entry start

  start: tool ghost_tool
    -> done

  done: terminal ok
`, known);

    expect(built.problems[0]?.message).toContain('calls tool "ghost_tool"');
    expect(built.problems[0]?.line).toBe(5);
  });

  it('catches a dangling edge and names the node it came from', () => {
    const built = compile(`
loop a v1
  entry start

  start: model
    -> nowhere
`, known);

    expect(built.problems.some((p) => p.message.includes('points at "nowhere"'))).toBe(true);
    expect(built.problems[0]?.line).toBe(5);
  });

  it('rejects an agent granted a tool that does not exist', () => {
    expect(messages('agent a v1\n  loop tool-rounds\n  tools not_a_tool\n'))
      .toContain('agent "a" is granted "not_a_tool", which is not a tool');
  });

  it('rejects an agent running a loop that does not exist', () => {
    expect(messages('agent a v1\n  loop ghost-loop\n'))
      .toContain('agent "a" runs loop "ghost-loop", which does not exist');
  });

  it('says when an agent never says which loop it runs', () => {
    expect(messages('agent a v1\n  describe does things\n'))
      .toContain('agent "a" does not say which loop it runs');
  });

  it('stops an agent calling itself', () => {
    expect(messages('agent a v1\n  loop tool-rounds\n  agents a\n'))
      .toContain('agent "a" may not call itself');
  });

  it('catches two loops or two agents sharing a name', () => {
    expect(messages('loop a v1\n  x: terminal ok\nloop a v1\n  y: terminal ok\n'))
      .toContain('two loops are called "a"');

    expect(messages('agent a v1\n  loop tool-rounds\nagent a v1\n  loop tool-rounds\n'))
      .toContain('two agents are called "a"');
  });

  it('lets an agent defined here be called by another agent defined here', () => {
    const built = compile(`
agent lead v1
  loop   tool-rounds
  agents hands

agent hands v1
  loop tool-rounds
`, known);

    expect(built.ok).toBe(true);
  });

  it('reports problems in line order, so a fix pass reads top to bottom', () => {
    const built = compile(`
loop a v1
  entry start

  start: tool ghost_one
    -> middle

  middle: tool ghost_two
    -> done

  done: terminal ok
`, known);

    const lines = built.problems.map((p) => p.line);
    expect(lines).toEqual([...lines].sort((x, y) => (x ?? 0) - (y ?? 0)));
  });

  it('does not claim success while an error stands', () => {
    expect(compile('loop a v1\n  x: tool ghost_tool\n', known).ok).toBe(false);
  });
});

describe('the report a model reads', () => {
  it('renders each problem as a line the author can act on', () => {
    const built = compile('loop a v1\n  start: tool ghost_tool\n', known);

    expect(formatProblems(built.problems)).toContain('line 2: ');
    expect(formatProblems(built.problems)).toContain('calls tool "ghost_tool"');
  });

  it('marks a warning as a warning so it is not read as a failure', () => {
    expect(formatProblems([{ severity: 'warning', message: 'unreachable', line: 9 }]))
      .toBe('line 9: warning: unreachable');
  });

  it('is empty when there is nothing to say', () => {
    expect(formatProblems([])).toBe('');
  });
});
