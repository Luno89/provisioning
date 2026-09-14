import { describe, it, expect, vi } from 'vitest';
import { scoreAttempt, summarise, type Attempt } from './score.js';
import { BUILDER_CASES, checkSuite, casesFor, type EvalCase } from './cases.js';
import { reliability, runCase, runSuite } from './run.js';
import { BUILDER_TOOLS } from '../builder-tools-catalogue.js';
import type { ToolDefinition } from '../catalogue.js';
import type { ModelCallArgs, ModelCallOutcome, RunEnvironment, RunTicket } from '../temporal/contracts.js';
import type { StreamToolCall } from '../stream.js';

const writeAgent = BUILDER_TOOLS.find((tool) => tool.name === 'write_agent')!;

const attempt = (over: Partial<Attempt> = {}): Attempt => ({
  toolCalls: [],
  content: '',
  ...over,
});

const calling = (name: string, args: unknown): Attempt =>
  attempt({ toolCalls: [{ name, arguments: JSON.stringify(args) }] });

describe('scoring what the model did', () => {
  it('passes a correct call', () => {
    const verdict = scoreAttempt(
      calling('write_agent', { source: 'agent a v1' }),
      { tool: 'write_agent' },
      writeAgent,
    );

    expect(verdict.passed).toBe(true);
  });

  it('says what it answered instead of calling anything', () => {
    const verdict = scoreAttempt(
      attempt({ content: 'I would start by considering the options available to us here.' }),
      { tool: 'write_agent' },
      writeAgent,
    );

    expect(verdict.complaint).toContain('called no tool, answered instead');
    expect(verdict.complaint).toContain('I would start by');
  });

  it('names what it called instead', () => {
    const verdict = scoreAttempt(calling('read_agent', { agent: 'x' }), { tool: 'write_agent' }, writeAgent);
    expect(verdict.complaint).toBe('called read_agent instead of write_agent');
  });

  it('catches a missing required argument and says what was sent', () => {
    const verdict = scoreAttempt(calling('write_agent', {}), { tool: 'write_agent' }, writeAgent);
    expect(verdict.complaint).toBe('called write_agent without source (sent nothing)');
  });

  it('names what was sent when the required argument is missing, so a wrong name is obvious', () => {
    const verdict = scoreAttempt(
      calling('write_agent', { agentText: 'agent a v1' }),
      { tool: 'write_agent' },
      writeAgent,
    );

    expect(verdict.complaint).toBe('called write_agent without source (sent agentText)');
  });

  it('catches an invented argument alongside the right one, which the schema did not offer', () => {
    const verdict = scoreAttempt(
      calling('write_agent', { source: 'agent a v1', overwrite: true }),
      { tool: 'write_agent' },
      writeAgent,
    );

    expect(verdict.complaint).toContain('invented arguments overwrite');
    expect(verdict.complaint).toContain('the schema offers source');
  });

  it('catches arguments that are not valid JSON', () => {
    const verdict = scoreAttempt(
      attempt({ toolCalls: [{ name: 'write_agent', arguments: '{not json' }] }),
      { tool: 'write_agent' },
      writeAgent,
    );

    expect(verdict.complaint).toContain('were not valid JSON');
  });

  it('passes when the wanted call is among several made', () => {
    const several = attempt({
      toolCalls: [
        { name: 'read_agent', arguments: '{"agent":"x"}' },
        { name: 'write_agent', arguments: '{"source":"agent a v1"}' },
      ],
    });

    expect(scoreAttempt(several, { tool: 'write_agent' }, writeAgent).passed).toBe(true);
  });
});

describe('checking the arguments a case cares about', () => {
  const check = (args: unknown, expect_: Parameters<typeof scoreAttempt>[1]) =>
    scoreAttempt(calling('write_agent', args), expect_, writeAgent);

  it('matches an exact value', () => {
    expect(check({ source: 'a' }, { tool: 'write_agent', args: [{ arg: 'source', is: 'a' }] }).passed).toBe(true);
    expect(check({ source: 'b' }, { tool: 'write_agent', args: [{ arg: 'source', is: 'a' }] }).complaint)
      .toContain('wanted a');
  });

  it('matches a substring, and quotes what it wanted when it is missing', () => {
    const verdict = check(
      { source: 'agent other v1' },
      { tool: 'write_agent', args: [{ arg: 'source', contains: 'agent tidy' }] },
    );

    expect(verdict.complaint).toContain('does not contain "agent tidy"');
    expect(verdict.complaint).toContain('agent other v1');
  });

  it('matches a pattern', () => {
    const ok = check(
      { source: 'agent a v1\n  loop  tool-rounds' },
      { tool: 'write_agent', args: [{ arg: 'source', matches: 'loop\\s+tool-rounds' }] },
    );

    expect(ok.passed).toBe(true);
  });

  it('catches an argument sent empty', () => {
    expect(check({ source: '   ' }, { tool: 'write_agent', args: [{ arg: 'source', nonEmpty: true }] }).complaint)
      .toContain('sent "source" empty');
  });
});

describe('irrelevance, where the right move is to call nothing', () => {
  it('passes when it answers instead of reaching for a tool', () => {
    expect(scoreAttempt(attempt({ content: 'An agent is the who; the loop is the how.' }), { tool: null }).passed)
      .toBe(true);
  });

  it('fails when it calls something anyway, and names it', () => {
    const verdict = scoreAttempt(calling('write_agent', { source: 'x' }), { tool: null });

    expect(verdict.passed).toBe(false);
    expect(verdict.complaint).toBe('called write_agent when it should have called nothing and answered');
  });

  it('fails a silent attempt, so a dead endpoint cannot score a pass here', () => {
    const verdict = scoreAttempt(attempt({ content: '' }), { tool: null });

    expect(verdict.passed).toBe(false);
    expect(verdict.complaint).toContain('answered nothing');
  });
});

describe('the seeded suite', () => {
  it('covers every builder tool with at least one case', () => {
    for (const tool of BUILDER_TOOLS) {
      expect(casesFor(tool.name).length, `${tool.name} has no case`).toBeGreaterThan(0);
    }
  });

  it('includes cases where calling nothing is correct', () => {
    expect(BUILDER_CASES.filter((entry) => entry.category === 'irrelevance').length).toBeGreaterThan(0);
  });

  it('reports the declared failures nothing provokes yet', () => {
    const gaps = checkSuite(BUILDER_TOOLS, BUILDER_CASES);
    const declared = BUILDER_TOOLS.flatMap((tool) => tool.failures).length;

    expect(gaps.filter((gap) => gap.message.includes('nothing provokes'))).toHaveLength(declared);
  });

  it('rejects a case pointing at a tool that does not exist', () => {
    const bogus: EvalCase = {
      name: 'x', category: 'simple', agent: 'agent-builder', say: 'do it',
      expect: { tool: 'no_such_tool' },
    };

    expect(checkSuite(BUILDER_TOOLS, [...BUILDER_CASES, bogus]).map((gap) => gap.message))
      .toContain('expects no_such_tool, which is not a tool');
  });

  it('rejects an irrelevance case that expects a call', () => {
    const confused: EvalCase = {
      name: 'x', category: 'irrelevance', agent: 'agent-builder', say: 'do it',
      expect: { tool: 'read_agent' },
    };

    expect(checkSuite(BUILDER_TOOLS, [confused]).map((gap) => gap.message))
      .toContain('is an irrelevance case but expects a tool call');
  });

  it('rejects a case claiming to provoke a failure the tool never declared', () => {
    const wrong: EvalCase = {
      name: 'x', category: 'simple', agent: 'agent-builder', say: 'do it',
      expect: { tool: 'write_agent' },
      provokes: { tool: 'write_agent', when: 'the moon is full' },
    };

    expect(checkSuite(BUILDER_TOOLS, [wrong]).map((gap) => gap.message).join(' '))
      .toContain('which write_agent does not list as a failure');
  });

  it('says when a suite has no irrelevance case at all', () => {
    const onlyHappy = BUILDER_CASES.filter((entry) => entry.category !== 'irrelevance');

    expect(checkSuite([], onlyHappy).map((gap) => gap.message).join(' '))
      .toContain('has no irrelevance case');
  });
});

describe('running a case against an endpoint', () => {
  const ports = (reply: () => { toolCalls: StreamToolCall[]; content: string }) => ({
    call: vi.fn(async (_args: ModelCallArgs): Promise<ModelCallOutcome> => {
      const made = reply();
      return { toolCalls: made.toolCalls, content: made.content, thinking: '', finishReason: 'stop' };
    }),
    environment: vi.fn(async (_ticket: RunTicket): Promise<RunEnvironment> =>
      ({ kind: 'none' as const, egress: false })),
    catalogue: vi.fn(async (_ownerId: string): Promise<ToolDefinition[]> => BUILDER_TOOLS),
  });

  const readCase = BUILDER_CASES.find((entry) => entry.name === 'read/by-name')!;

  it('repeats a case and reports how often it passed', async () => {
    let turn = 0;
    const used = ports(() => {
      turn += 1;
      return turn % 2 === 0
        ? { toolCalls: [{ id: 'c1', name: 'read_agent', arguments: '{"agent":"research"}' }], content: '' }
        : { toolCalls: [], content: 'let me think about that' };
    });

    const outcome = await runCase(readCase, { ports: used, ownerId: 'user-1', repeats: 4 });

    expect(outcome.attempts).toBe(4);
    expect(outcome.passed).toBe(2);
    expect(outcome.complaints[0]).toContain('called no tool');
  });

  it('gives each attempt its own run id, so nothing shares an environment', async () => {
    const used = ports(() => ({ toolCalls: [{ id: 'c1', name: 'read_agent', arguments: '{"agent":"research"}' }], content: '' }));
    await runCase(readCase, { ports: used, ownerId: 'user-1', repeats: 3 });

    const ids = used.call.mock.calls.map(([args]) => args.ticket.runId);
    expect(new Set(ids).size).toBe(3);
  });

  it('records a call that throws rather than losing the attempt', async () => {
    const used = {
      ...ports(() => ({ toolCalls: [], content: '' })),
      call: vi.fn(async () => { throw new Error('endpoint refused the connection'); }),
    };

    const outcome = await runCase(readCase, { ports: used, ownerId: 'user-1', repeats: 2 });

    expect(outcome.passed).toBe(0);
    expect(outcome.complaints[0]).toContain('endpoint refused the connection');
  });

  it('reports reliability rather than an average', async () => {
    const used = ports(() => ({ toolCalls: [{ id: 'c1', name: 'read_agent', arguments: '{"agent":"research"}' }], content: '' }));
    const outcomes = await runSuite(casesFor('read_agent'), { ports: used, ownerId: 'user-1', repeats: 2 });

    expect(reliability(outcomes)).toMatchObject({ cases: 2, always: 1, never: 1, flaky: 0 });
  });
});

describe('the report', () => {
  it('marks a case that always passed, never passed, and sometimes passed', () => {
    const text = summarise([
      { name: 'a', category: 'simple', attempts: 5, passed: 5, complaints: [] },
      { name: 'b', category: 'simple', attempts: 5, passed: 0, complaints: ['called no tool'] },
      { name: 'c', category: 'simple', attempts: 5, passed: 3, complaints: ['called no tool', 'called no tool'] },
    ]);

    expect(text).toContain('pass  a');
    expect(text).toContain('FAIL  b');
    expect(text).toContain('flaky c');
    expect(text).toContain('1/3 cases passed every time');
  });

  it('says each distinct complaint once rather than repeating it per attempt', () => {
    const text = summarise([
      { name: 'a', category: 'simple', attempts: 3, passed: 0, complaints: ['same', 'same', 'other'] },
    ]);

    expect(text.match(/same/g)).toHaveLength(1);
    expect(text).toContain('other');
  });
});
