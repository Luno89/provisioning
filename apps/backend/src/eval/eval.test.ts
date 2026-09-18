import { describe, it, expect, vi } from 'vitest';
import { byTool, scoreAttempt, summarise, type Attempt, type ArgCheck } from './score.js';
import { BUILDER_CASES, checkSuite, casesFor, type EvalCase } from './cases.js';
import { reliability } from './run.js';
import {
  BUILDER_TOOLS,
  type ToolDefinition,
  type StreamToolCall,
} from '@koala/agent-engine';
import type {
  RunEnvironment,
  RunTicket,
} from '../engine-host/index.js';

const writeProcedure = BUILDER_TOOLS.find((tool) => tool.name === 'save_procedure')!;

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
      calling('save_procedure', { source: 'agent a v1' }),
      { tool: 'save_procedure' },
      writeProcedure,
    );

    expect(verdict.passed).toBe(true);
  });

  it('says what it answered instead of calling anything', () => {
    const verdict = scoreAttempt(
      attempt({ content: 'I would start by considering the options available to us here.' }),
      { tool: 'save_procedure' },
      writeProcedure,
    );

    expect(verdict.complaint).toContain('called no tool, answered instead');
    expect(verdict.complaint).toContain('I would start by');
  });

  it('names what it called instead', () => {
    const verdict = scoreAttempt(calling('read_procedure', { agent: 'x' }), { tool: 'save_procedure' }, writeProcedure);
    expect(verdict.complaint).toBe('called read_procedure instead of save_procedure');
  });

  it('catches a missing required argument and says what was sent', () => {
    const verdict = scoreAttempt(calling('save_procedure', {}), { tool: 'save_procedure' }, writeProcedure);
    expect(verdict.complaint).toBe('called save_procedure without source (sent nothing)');
  });

  it('names what was sent when the required argument is missing, so a wrong name is obvious', () => {
    const verdict = scoreAttempt(
      calling('save_procedure', { agentText: 'agent a v1' }),
      { tool: 'save_procedure' },
      writeProcedure,
    );

    expect(verdict.complaint).toBe('called save_procedure without source (sent agentText)');
  });

  it('catches an invented argument alongside the right one, which the schema did not offer', () => {
    const verdict = scoreAttempt(
      calling('save_procedure', { source: 'agent a v1', overwrite: true }),
      { tool: 'save_procedure' },
      writeProcedure,
    );

    expect(verdict.complaint).toContain('invented arguments overwrite');
    expect(verdict.complaint).toContain('the schema offers source');
  });

  it('catches arguments that are not valid JSON', () => {
    const verdict = scoreAttempt(
      attempt({ toolCalls: [{ name: 'save_procedure', arguments: '{not json' }] }),
      { tool: 'save_procedure' },
      writeProcedure,
    );

    expect(verdict.complaint).toContain('were not valid JSON');
  });

  it('passes when the wanted call is among several made', () => {
    const several = attempt({
      toolCalls: [
        { name: 'read_procedure', arguments: '{"agent":"x"}' },
        { name: 'save_procedure', arguments: '{"source":"agent a v1"}' },
      ],
    });

    expect(scoreAttempt(several, { tool: 'save_procedure' }, writeProcedure).passed).toBe(true);
  });
});

describe('checking the arguments a case cares about', () => {
  const check = (args: unknown, expect_: Parameters<typeof scoreAttempt>[1]) =>
    scoreAttempt(calling('save_procedure', args), expect_, writeProcedure);

  it('matches an exact value', () => {
    expect(check({ source: 'a' }, { tool: 'save_procedure', args: [{ arg: 'source', is: 'a' }] }).passed).toBe(true);
    expect(check({ source: 'b' }, { tool: 'save_procedure', args: [{ arg: 'source', is: 'a' }] }).complaint)
      .toContain('wanted a');
  });

  it('matches a substring, and quotes what it wanted when it is missing', () => {
    const verdict = check(
      { source: 'agent other v1' },
      { tool: 'save_procedure', args: [{ arg: 'source', contains: 'agent tidy' }] },
    );

    expect(verdict.complaint).toContain('does not contain "agent tidy"');
    expect(verdict.complaint).toContain('agent other v1');
  });

  it('matches a pattern', () => {
    const ok = check(
      { source: 'agent a v1\n  loop  tool-rounds' },
      { tool: 'save_procedure', args: [{ arg: 'source', matches: 'loop\\s+tool-rounds' }] },
    );

    expect(ok.passed).toBe(true);
  });

  it('catches an argument sent empty', () => {
    expect(check({ source: '   ' }, { tool: 'save_procedure', args: [{ arg: 'source', nonEmpty: true }] }).complaint)
      .toContain('sent "source" empty');
  });

  it('matches boolean values case-insensitively whether string or boolean', () => {
    const boolTool = {
      name: 'list_tasks',
      description: 'list tasks',
      parameters: {
        type: 'object' as const,
        properties: { ready: { type: 'boolean' } },
      },
      failures: [],
    };
    const checkBool = (args: unknown, check_: ArgCheck) =>
      scoreAttempt(calling('list_tasks', args), { tool: 'list_tasks', args: [check_] }, boolTool as any);

    expect(checkBool({ ready: true }, { arg: 'ready', is: 'true' }).passed).toBe(true);
    expect(checkBool({ ready: 'True' }, { arg: 'ready', is: 'true' }).passed).toBe(true);
    expect(checkBool({ ready: 'true' }, { arg: 'ready', is: 'true' }).passed).toBe(true);
    expect(checkBool({ ready: false }, { arg: 'ready', is: 'false' }).passed).toBe(true);
    expect(checkBool({ ready: 'False' }, { arg: 'ready', is: 'false' }).passed).toBe(true);
    expect(checkBool({ ready: false }, { arg: 'ready', is: 'true' }).complaint)
      .toContain('wanted true');
  });
});

describe('irrelevance, where the right move is to call nothing', () => {
  it('passes when it answers instead of reaching for a tool', () => {
    expect(scoreAttempt(attempt({ content: 'An agent is the who; the loop is the how.' }), { tool: null }).passed)
      .toBe(true);
  });

  it('fails when it calls something anyway, and names it', () => {
    const verdict = scoreAttempt(calling('save_procedure', { source: 'x' }), { tool: null });

    expect(verdict.passed).toBe(false);
    expect(verdict.complaint).toBe('called save_procedure when it should have called nothing and answered');
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
      expect: { tool: 'read_procedure' },
    };

    expect(checkSuite(BUILDER_TOOLS, [confused]).map((gap) => gap.message))
      .toContain('is an irrelevance case but expects a tool call');
  });

  it('rejects a case claiming to provoke a failure the tool never declared', () => {
    const wrong: EvalCase = {
      name: 'x', category: 'simple', agent: 'agent-builder', say: 'do it',
      expect: { tool: 'save_procedure' },
      provokes: { tool: 'save_procedure', when: 'the moon is full' },
    };

    expect(checkSuite(BUILDER_TOOLS, [wrong]).map((gap) => gap.message).join(' '))
      .toContain('which save_procedure does not list as a failure');
  });

  it('says when a suite has no irrelevance case at all', () => {
    const onlyHappy = BUILDER_CASES.filter((entry) => entry.category !== 'irrelevance');

    expect(checkSuite([], onlyHappy).map((gap) => gap.message).join(' '))
      .toContain('has no irrelevance case');
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

describe('scoring a run by tool rather than by case', () => {
  const outcome = (name: string, passed: number, attempts: number, complaints: string[] = []) =>
    ({ name, category: 'simple', attempts, passed, complaints });

  const cases = [
    { name: 'a/one', expect: { tool: 'read_file' } },
    { name: 'a/two', expect: { tool: 'read_file' } },
    { name: 'b/one', expect: { tool: 'run_command' } },
    { name: 'c/one', expect: { tool: null } },
  ];

  it('adds up every case that wanted the same tool', () => {
    const scores = byTool(cases, [
      outcome('a/one', 8, 10, ['called run_command instead of read_file']),
      outcome('a/two', 10, 10),
      outcome('b/one', 10, 10),
    ]);

    expect(scores.find((score) => score.tool === 'read_file')).toMatchObject({
      cases: 2,
      attempts: 20,
      passed: 18,
      complaints: ['called run_command instead of read_file'],
    });
  });

  it('puts the weakest tool first, since that is the one to look at', () => {
    const scores = byTool(cases, [
      outcome('a/one', 10, 10),
      outcome('b/one', 3, 10),
    ]);

    expect(scores.map((score) => score.tool)).toEqual(['run_command', 'read_file']);
  });

  it('keeps the cases that call nothing as their own line', () => {
    const scores = byTool(cases, [outcome('c/one', 9, 10)]);

    expect(scores[0]!.tool).toContain('without calling anything');
  });

  it('does not double-count a complaint two cases both made', () => {
    const scores = byTool(cases, [
      outcome('a/one', 5, 10, ['called no tool and said nothing']),
      outcome('a/two', 5, 10, ['called no tool and said nothing']),
    ]);

    expect(scores.find((score) => score.tool === 'read_file')!.complaints)
      .toEqual(['called no tool and said nothing']);
  });
});
